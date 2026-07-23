'use strict';

const express = require('express');
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * PG-style payment routes mounted on the public app.
 * Uses core gateway (create-qris + check-payment) under the hood.
 */
function createPaymentRouter({ store, autoChecker, coreBase, apiKey, apiKeyMiddleware }) {
  const router = express.Router();
  const base = (coreBase || 'http://127.0.0.1:4001').replace(/\/$/, '');

  function coreRequest(method, p, body, extraHeaders = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(base + p);
      const lib = u.protocol === 'https:' ? https : http;
      const data = body ? JSON.stringify(body) : null;
      const headers = {
        'X-API-Key': apiKey,
        ...extraHeaders,
      };
      if (data) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers,
          timeout: 25000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const raw = Buffer.concat(chunks).toString('utf8');
            let parsed = raw;
            try {
              parsed = raw ? JSON.parse(raw) : {};
            } catch (_) {}
            resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: parsed, raw });
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('core request timeout'));
      });
      if (data) req.write(data);
      req.end();
    });
  }

  // Random amount suffix: MATI secara default.
  // ShopeePay punya transactionId unik → dedup akurat tanpa nominal acak.
  // Aktifkan via env UNIQUE_AMOUNT=true kalau mau legacy mode (QRIS statis / GoPay).
  function pickAmount(baseAmount) {
    const enable = String(process.env.UNIQUE_AMOUNT || 'false').toLowerCase() !== 'false';
    if (!enable) return { amount: baseAmount, suffix: 0 };
    const suffix = 1 + Math.floor(Math.random() * 99);
    return { amount: baseAmount + suffix, suffix };
  }

  // Create payment (like PG create invoice)
  router.post('/create', apiKeyMiddleware, async (req, res) => {
    try {
      const body = req.body || {};
      const baseAmount = Number(body.amount);
      if (!baseAmount || baseAmount <= 0) {
        return res.status(400).json({ success: false, error: 'Provide valid amount (positive integer)' });
      }

      const { amount, suffix } = pickAmount(baseAmount);
      const startTime = Math.floor(Date.now() / 1000); // seconds for core
      const webhook_url = body.webhook_url || body.callback_url || null;
      const metadata = body.metadata || {};
      const external_id = body.external_id || body.order_id || null;

      const extra = {};
      if (req.headers['x-shopee-token']) extra['X-Shopee-Token'] = req.headers['x-shopee-token'];

      const qris = await coreRequest('POST', '/create-qris', { amount }, extra);
      if (!qris.ok || !qris.data || !qris.data.success) {
        return res.status(qris.status || 500).json({
          success: false,
          error: (qris.data && (qris.data.error || qris.data.message)) || 'Failed to create QRIS',
          core: qris.data,
        });
      }

      const qdata = qris.data.data || qris.data;
      // extract id from qris_url if present (.../qr/ID)
      let qrisId = null;
      let qrisUrl = qdata.qris_url || null;
      if (qrisUrl) {
        const m = String(qrisUrl).match(/\/qr\/([^/?#]+)/);
        if (m) qrisId = m[1];
      }
      // Core returns internal host (127.0.0.1:CORE_PORT) — rewrite to public host
      if (qrisId) {
        const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0].trim();
        const host = (req.headers['x-forwarded-host'] || req.headers.host || '').toString().split(',')[0].trim();
        if (host) qrisUrl = `${proto}://${host}/qr/${qrisId}`;
      }

      const session = store.create({
        amount,
        base_amount: baseAmount,
        unique_suffix: suffix,
        qris_url: qrisUrl,
        qris_id: qrisId,
        startTime,
        expires_at: qdata.expires_at,
        expires_in: qdata.expires_in || 900,
        webhook_url,
        metadata,
        external_id,
      });

      return res.status(201).json({
        success: true,
        data: {
          payment_id: session.id,
          external_id: session.external_id,
          status: session.status,
          amount: session.amount,
          base_amount: session.base_amount,
          unique_suffix: session.unique_suffix,
          qris_url: session.qris_url,
          expires_at: session.expires_at,
          expires_in: session.expires_in,
          startTime: session.startTime,
          check_url: `/payments/${session.id}`,
          auto_check: true,
          poll_interval_ms: Number(process.env.AUTO_CHECK_INTERVAL_MS || 10000),
          webhook_url: session.webhook_url,
          metadata: session.metadata,
        },
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Get payment status (optionally force one check)
  router.get('/:id', apiKeyMiddleware, async (req, res) => {
    try {
      let session = store.get(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Payment not found' });

      const force = String(req.query.refresh || req.query.check || '') === '1' || req.query.refresh === 'true';
      if (force && session.status === 'pending' && autoChecker) {
        session = (await autoChecker.forceCheck(session.id)) || session;
      }

      return res.json({
        success: true,
        data: publicSession(session),
      });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Manual check trigger
  router.post('/:id/check', apiKeyMiddleware, async (req, res) => {
    try {
      let session = store.get(req.params.id);
      if (!session) return res.status(404).json({ success: false, error: 'Payment not found' });
      if (session.status !== 'pending') {
        return res.json({ success: true, data: publicSession(session), message: 'Session already terminal' });
      }
      session = (await autoChecker.forceCheck(session.id)) || session;
      return res.json({ success: true, data: publicSession(session) });
    } catch (err) {
      return res.status(500).json({ success: false, error: err.message });
    }
  });

  // Cancel pending payment (stop auto-check)
  router.post('/:id/cancel', apiKeyMiddleware, (req, res) => {
    const session = store.get(req.params.id);
    if (!session) return res.status(404).json({ success: false, error: 'Payment not found' });
    if (session.status !== 'pending') {
      return res.status(400).json({ success: false, error: `Cannot cancel status=${session.status}` });
    }
    const updated = store.update(session.id, { status: 'cancelled', last_error: 'Cancelled by client' });
    return res.json({ success: true, data: publicSession(updated) });
  });

  // List payments
  router.get('/', apiKeyMiddleware, (req, res) => {
    const items = store.list({ status: req.query.status, limit: req.query.limit });
    return res.json({
      success: true,
      data: {
        stats: store.stats(),
        payments: items.map(publicSession),
      },
    });
  });

  return router;
}

function publicSession(s) {
  if (!s) return null;
  return {
    payment_id: s.id,
    external_id: s.external_id,
    status: s.status,
    amount: s.amount,
    base_amount: s.base_amount,
    unique_suffix: s.unique_suffix,
    qris_url: s.qris_url,
    expires_at: s.expires_at,
    expires_in: s.expires_in,
    startTime: s.startTime,
    transaction: s.transaction,
    poll_count: s.poll_count,
    last_poll_at: s.last_poll_at,
    last_error: s.last_error,
    webhook_url: s.webhook_url,
    webhook_delivered: s.webhook_delivered,
    webhook_attempts: s.webhook_attempts,
    metadata: s.metadata,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    paidAt: s.paidAt,
  };
}

module.exports = { createPaymentRouter, publicSession };
