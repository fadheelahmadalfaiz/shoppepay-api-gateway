'use strict';

/**
 * Public entrypoint (PG mode)
 * - Starts obfuscated core gateway on CORE_PORT (internal)
 * - Exposes public PORT with original core routes proxied + /payments/* auto-check API
 *
 * Env:
 *   PORT                 public port (default 4000)
 *   CORE_PORT            internal core port (default 4001)
 *   API_KEY              shared with core
 *   AUTO_CHECK_INTERVAL_MS  default 10000
 *   AUTO_CHECK_MAX_POLLS    default 120
 *   UNIQUE_AMOUNT           true|false (default true) add +1..99 to amount
 *   PAYMENT_STORE_PATH      optional JSON persist path (default ./data/payments.json)
 *   WEBHOOK default none — pass per payment
 */

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const { PaymentStore } = require('./lib/payment-store');
const { AutoChecker } = require('./lib/auto-checker');
const { createPaymentRouter } = require('./routes/payments');

const PUBLIC_PORT = Number(process.env.PORT || 4000);
const CORE_PORT = Number(process.env.CORE_PORT || 4001);
const API_KEY = process.env.API_KEY || '';
const CORE_BASE = `http://127.0.0.1:${CORE_PORT}`;
const STORE_PATH =
  process.env.PAYMENT_STORE_PATH || path.join(__dirname, 'data', 'payments.json');

// ---------- spawn core (obfuscated) on internal port ----------
function startCore() {
  return new Promise((resolve, reject) => {
    const coreFile = path.join(__dirname, 'core-gateway.js');
    if (!fs.existsSync(coreFile)) {
      return reject(new Error('core-gateway.js missing'));
    }

    const env = {
      ...process.env,
      PORT: String(CORE_PORT),
      // ensure core doesn't clash; public app owns PUBLIC_PORT
    };

    const child = spawn(process.execPath, [coreFile], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    });

    let booted = false;
    const onData = (buf) => {
      const s = buf.toString();
      process.stdout.write(`[core] ${s}`);
      if (!booted && /listening|Endpoints:|running|port/i.test(s)) {
        // soft signal — also active-probe
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (b) => process.stderr.write(`[core:err] ${b}`));
    child.on('exit', (code) => {
      console.error(`[core] exited code=${code}`);
      if (!booted) reject(new Error(`core exited early code=${code}`));
      else process.exit(code || 1);
    });

    // probe until /api/health answers
    const started = Date.now();
    const probe = () => {
      const req = http.get(`${CORE_BASE}/api/health`, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode < 500) {
          booted = true;
          console.log(`[boot] core ready on :${CORE_PORT}`);
          resolve(child);
        } else {
          retry();
        }
      });
      req.on('error', retry);
      req.setTimeout(2000, () => {
        req.destroy();
        retry();
      });
    };
    const retry = () => {
      if (Date.now() - started > 30000) return reject(new Error('core boot timeout 30s'));
      setTimeout(probe, 400);
    };
    setTimeout(probe, 500);

    // keep handle
    startCore.child = child;
  });
}

function proxyToCore(req, res) {
  const headers = { ...req.headers, host: `127.0.0.1:${CORE_PORT}` };
  // strip hop-by-hop
  delete headers['content-length'];

  const opts = {
    hostname: '127.0.0.1',
    port: CORE_PORT,
    path: req.originalUrl,
    method: req.method,
    headers,
    timeout: 30000,
  };

  const preq = http.request(opts, (pres) => {
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });
  preq.on('error', (err) => {
    if (!res.headersSent) res.status(502).json({ success: false, error: 'core unavailable: ' + err.message });
  });
  preq.on('timeout', () => {
    preq.destroy();
    if (!res.headersSent) res.status(504).json({ success: false, error: 'core timeout' });
  });
  req.pipe(preq);
}

function apiKeyMiddleware(req, res, next) {
  if (!API_KEY) return next(); // open if unset (dev)
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!key || key !== API_KEY) {
    return res.status(401).json({ success: false, error: 'Invalid or missing API key' });
  }
  next();
}

async function main() {
  console.log('======= ShopeePay Gateway + Auto-Check PG =======');
  await startCore();

  const store = new PaymentStore({ filePath: STORE_PATH });
  const autoChecker = new AutoChecker({
    store,
    coreBase: CORE_BASE,
    apiKey: API_KEY,
    intervalMs: process.env.AUTO_CHECK_INTERVAL_MS,
    maxPolls: process.env.AUTO_CHECK_MAX_POLLS,
  });
  autoChecker.start();

  const app = express();
  app.use(cors({ origin: '*', credentials: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true }));

  // PG health (enriched)
  app.get('/api/health', (req, res) => {
    res.json({
      success: true,
      message: 'ShopeePay API Service is running (auto-check PG mode)',
      mode: 'pg-auto-check',
      core: CORE_BASE,
      payments: store.stats(),
      auto_check: {
        interval_ms: autoChecker.intervalMs,
        max_polls: autoChecker.maxPolls,
        running: autoChecker.running,
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.get('/', (req, res) => {
    res.type('text').send('Shoppe API Running (PG auto-check)');
  });

  // Payment PG routes
  app.use(
    '/payments',
    createPaymentRouter({
      store,
      autoChecker,
      coreBase: CORE_BASE,
      apiKey: API_KEY,
      apiKeyMiddleware,
    })
  );

  // Proxy original core endpoints so existing clients keep working
  const corePaths = [
    '/create-qris',
    '/check-payment',
    '/transactions',
    '/transactions/all',
    '/token-status',
    '/update-token',
    '/api/logs',
  ];
  for (const p of corePaths) {
    app.all(p, (req, res) => proxyToCore(req, res));
  }
  // QR image redirect
  app.get('/qr/:id', (req, res) => proxyToCore(req, res));

  app.listen(PUBLIC_PORT, () => {
    console.log(`[boot] public PG listening on :${PUBLIC_PORT}`);
    console.log('  POST /payments/create     - create payment + start auto-check');
    console.log('  GET  /payments/:id        - status (?refresh=1 force check)');
    console.log('  POST /payments/:id/check  - force check now');
    console.log('  POST /payments/:id/cancel - cancel pending');
    console.log('  GET  /payments            - list payments');
    console.log('  (core routes still available: /create-qris, /check-payment, ...)');
  });

  const shutdown = () => {
    console.log('[boot] shutting down...');
    autoChecker.stop();
    if (startCore.child) startCore.child.kill('SIGTERM');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[boot] fatal:', err);
  process.exit(1);
});
