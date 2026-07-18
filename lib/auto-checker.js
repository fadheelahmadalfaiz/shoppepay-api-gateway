'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

/**
 * Background auto-checker: polls core /check-payment for every pending session.
 * On paid → mark session, claim transactionId, fire webhook + optional Telegram.
 */
class AutoChecker {
  constructor({ store, coreBase, apiKey, intervalMs, maxPolls, onLog }) {
    this.store = store;
    this.coreBase = (coreBase || 'http://127.0.0.1:4001').replace(/\/$/, '');
    this.apiKey = apiKey || '';
    this.intervalMs = Number(intervalMs || process.env.AUTO_CHECK_INTERVAL_MS || 10000);
    this.maxPolls = Number(maxPolls || process.env.AUTO_CHECK_MAX_POLLS || 120); // ~20 min @10s
    this.onLog = onLog || ((level, msg) => console.log(`[auto-check][${level}] ${msg}`));
    this.timer = null;
    this.running = false;
    this.busy = false;
  }

  start() {
    if (this.timer) return;
    this.running = true;
    this.onLog('INFO', `Auto-checker started (every ${this.intervalMs}ms → ${this.coreBase})`);
    // first tick slightly delayed so core is up
    this.timer = setInterval(() => this.tick().catch(() => {}), this.intervalMs);
    setTimeout(() => this.tick().catch(() => {}), 1500);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick() {
    if (this.busy || !this.running) return;
    this.busy = true;
    try {
      const pending = this.store.pendingForPoll();
      for (const session of pending) {
        if (session.poll_count >= this.maxPolls) {
          this.store.update(session.id, {
            status: 'expired',
            last_error: `Max polls reached (${this.maxPolls})`,
          });
          continue;
        }
        await this.checkOne(session);
      }
    } finally {
      this.busy = false;
    }
  }

  async checkOne(session) {
    const body = {
      amount: session.amount,
      startTime: session.startTime, // unix seconds (core expects seconds)
    };
    try {
      const res = await this._request('POST', '/check-payment', body);
      this.store.update(session.id, {
        poll_count: (session.poll_count || 0) + 1,
        last_poll_at: new Date().toISOString(),
        last_error: res.ok ? null : (res.data && (res.data.error || res.data.message)) || `HTTP ${res.status}`,
      });

      if (!res.ok) {
        this.onLog('WARN', `check ${session.id} failed: HTTP ${res.status} ${JSON.stringify(res.data).slice(0, 200)}`);
        return;
      }

      if (res.data && res.data.paid === true && res.data.transaction) {
        const tx = res.data.transaction;
        const txId = String(tx.transactionId || tx.displayTransactionId || '');
        if (txId && this.store.isTxClaimed(txId)) {
          this.onLog('WARN', `tx ${txId} already claimed — skip ${session.id}`);
          return;
        }
        if (txId) this.store.claimTx(txId, session.id);

        const updated = this.store.update(session.id, {
          status: 'paid',
          transaction: tx,
          paidAt: new Date().toISOString(),
          last_error: null,
        });
        this.onLog('INFO', `PAID ${session.id} amount=${session.amount} tx=${txId} issuer=${tx.issuer || '-'}`);
        await this._deliverWebhook(updated);
        await this._notifyTelegram(updated);
      }
    } catch (err) {
      this.store.update(session.id, {
        poll_count: (session.poll_count || 0) + 1,
        last_poll_at: new Date().toISOString(),
        last_error: err.message,
      });
      this.onLog('ERROR', `check ${session.id}: ${err.message}`);
    }
  }

  /** Force immediate check (used by GET refresh) */
  async forceCheck(paymentId) {
    const s = this.store.get(paymentId);
    if (!s) return null;
    if (s.status === 'pending') await this.checkOne(s);
    return this.store.get(paymentId);
  }

  async _deliverWebhook(session) {
    if (!session || !session.webhook_url) return;
    if (session.webhook_delivered) return;

    const payload = {
      event: 'payment.paid',
      payment_id: session.id,
      external_id: session.external_id,
      amount: session.amount,
      status: session.status,
      transaction: session.transaction,
      metadata: session.metadata,
      paid_at: session.paidAt,
    };

    const maxAttempts = 3;
    for (let i = 1; i <= maxAttempts; i++) {
      try {
        const r = await this._postJson(session.webhook_url, payload);
        this.store.update(session.id, {
          webhook_attempts: i,
          webhook_delivered: r.status >= 200 && r.status < 300,
          last_error: r.status >= 200 && r.status < 300 ? null : `webhook HTTP ${r.status}`,
        });
        if (r.status >= 200 && r.status < 300) {
          this.onLog('INFO', `webhook OK ${session.id} → ${session.webhook_url}`);
          return;
        }
      } catch (err) {
        this.store.update(session.id, {
          webhook_attempts: i,
          last_error: `webhook: ${err.message}`,
        });
      }
      await new Promise((r) => setTimeout(r, 500 * i));
    }
    this.onLog('WARN', `webhook failed after ${maxAttempts} tries: ${session.id}`);
  }

  async _notifyTelegram(session) {
    const token = process.env.TELEGRAM_BOT_TOKEN || '';
    const chat = process.env.TELEGRAM_CHAT_ID || '';
    if (!token || !chat) return;
    const tx = session.transaction || {};
    const text =
      `✅ *Pembayaran LUNAS*\n` +
      `ID: \`${session.id}\`\n` +
      `Nominal: Rp ${Number(session.amount).toLocaleString('id-ID')}\n` +
      `Issuer: ${tx.issuer || '-'}\n` +
      `Tx: \`${tx.transactionId || '-'}\`\n` +
      `Waktu: ${tx.time || session.paidAt || '-'}`;
    try {
      await this._postJson(`https://api.telegram.org/bot${token}/sendMessage`, {
        chat_id: chat,
        text,
        parse_mode: 'Markdown',
      });
    } catch (err) {
      this.onLog('WARN', `telegram notify failed: ${err.message}`);
    }
  }

  _request(method, p, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(this.coreBase + p);
      const lib = u.protocol === 'https:' ? https : http;
      const data = body ? JSON.stringify(body) : null;
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': this.apiKey,
            ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}),
          },
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
            resolve({ status: res.statusCode, ok: res.statusCode >= 200 && res.statusCode < 300, data: parsed });
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

  _postJson(urlStr, body) {
    return new Promise((resolve, reject) => {
      const u = new URL(urlStr);
      const lib = u.protocol === 'https:' ? https : http;
      const data = JSON.stringify(body);
      const req = lib.request(
        {
          hostname: u.hostname,
          port: u.port || (u.protocol === 'https:' ? 443 : 80),
          path: u.pathname + u.search,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
            'User-Agent': 'shoppepay-auto-check/1.0',
          },
          timeout: 15000,
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        }
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('webhook timeout'));
      });
      req.write(data);
      req.end();
    });
  }
}

module.exports = { AutoChecker };
