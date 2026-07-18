'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/**
 * Lightweight payment session store.
 * - In-memory Map (fast path)
 * - Optional JSON file persistence so restarts don't drop pending/paid sessions
 */
class PaymentStore {
  constructor(options = {}) {
    this.filePath = options.filePath || process.env.PAYMENT_STORE_PATH || '';
    this.ttlMs = Number(options.ttlMs || process.env.PAYMENT_TTL_MS || 24 * 60 * 60 * 1000);
    this.sessions = new Map();
    this.claimedTx = new Map(); // transactionId -> paymentId (anti double-claim)
    this._load();
  }

  _load() {
    if (!this.filePath) return;
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const sessions = raw.sessions || [];
      const claimed = raw.claimedTx || {};
      const now = Date.now();
      for (const s of sessions) {
        if (s && s.id) {
          // drop very old terminal sessions
          const updated = new Date(s.updatedAt || s.createdAt || 0).getTime();
          if (now - updated <= this.ttlMs * 2) this.sessions.set(s.id, s);
        }
      }
      for (const [tx, pid] of Object.entries(claimed)) {
        this.claimedTx.set(tx, pid);
      }
    } catch (err) {
      console.warn('[payment-store] load failed:', err.message);
    }
  }

  _save() {
    if (!this.filePath) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const payload = {
        savedAt: new Date().toISOString(),
        sessions: Array.from(this.sessions.values()),
        claimedTx: Object.fromEntries(this.claimedTx.entries()),
      };
      const tmp = this.filePath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[payment-store] save failed:', err.message);
    }
  }

  create(data) {
    const id = data.id || ('pay_' + crypto.randomBytes(8).toString('hex'));
    const now = new Date().toISOString();
    const session = {
      id,
      status: 'pending',
      amount: Number(data.amount),
      base_amount: data.base_amount != null ? Number(data.base_amount) : Number(data.amount),
      unique_suffix: data.unique_suffix != null ? Number(data.unique_suffix) : 0,
      qris_url: data.qris_url || null,
      qris_id: data.qris_id || null,
      startTime: Number(data.startTime), // unix seconds
      expires_at: data.expires_at || null,
      expires_in: data.expires_in || 900,
      webhook_url: data.webhook_url || null,
      metadata: data.metadata || {},
      external_id: data.external_id || null,
      transaction: null,
      poll_count: 0,
      last_poll_at: null,
      last_error: null,
      webhook_delivered: false,
      webhook_attempts: 0,
      createdAt: now,
      updatedAt: now,
      paidAt: null,
    };
    this.sessions.set(id, session);
    this._save();
    return session;
  }

  get(id) {
    return this.sessions.get(id) || null;
  }

  update(id, patch) {
    const s = this.sessions.get(id);
    if (!s) return null;
    Object.assign(s, patch, { updatedAt: new Date().toISOString() });
    this.sessions.set(id, s);
    this._save();
    return s;
  }

  list(filter = {}) {
    let items = Array.from(this.sessions.values());
    if (filter.status) items = items.filter((s) => s.status === filter.status);
    items.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    const limit = Number(filter.limit || 50);
    return items.slice(0, Math.min(limit, 200));
  }

  isTxClaimed(txId) {
    return this.claimedTx.has(String(txId));
  }

  claimTx(txId, paymentId) {
    const key = String(txId);
    if (this.claimedTx.has(key)) return false;
    this.claimedTx.set(key, paymentId);
    this._save();
    return true;
  }

  /** Pending sessions that still need polling */
  pendingForPoll(nowMs = Date.now()) {
    const out = [];
    for (const s of this.sessions.values()) {
      if (s.status !== 'pending') continue;
      // expire by wall clock if expires_at parseable, else by startTime+expires_in
      let expired = false;
      if (s.expires_at) {
        const exp = Date.parse(s.expires_at.replace(' ', 'T') + '+07:00');
        if (!Number.isNaN(exp) && nowMs > exp) expired = true;
      } else if (s.startTime && s.expires_in) {
        if (nowMs > (s.startTime * 1000) + (Number(s.expires_in) * 1000)) expired = true;
      }
      if (expired) {
        this.update(s.id, { status: 'expired', last_error: 'Payment session expired' });
        continue;
      }
      out.push(s);
    }
    return out;
  }

  stats() {
    const all = Array.from(this.sessions.values());
    const by = { pending: 0, paid: 0, expired: 0, cancelled: 0 };
    for (const s of all) by[s.status] = (by[s.status] || 0) + 1;
    return { total: all.length, claimed_tx: this.claimedTx.size, ...by };
  }
}

module.exports = { PaymentStore };
