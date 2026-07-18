# ShopeePay Unofficial Gateway — PG Auto-Check (AI Integration Spec)

> **Audience:** AI agents / coding assistants that will integrate or extend this payment system.  
> **Language:** Indonesian + technical English terms.  
> **Status:** Production-capable layer on top of unofficial ShopeePay Partner API.  
> **Do not invent credentials.** Use env values provided by operator only.

---

## 0) One-sentence summary

This service turns a **stateless ShopeePay mutation checker + QRIS generator** into a **mini Payment Gateway**: create payment → show QR → **server auto-polls** until paid → mark paid + anti double-claim + optional webhook/Telegram.

---

## 1) Repos & live target

| Role | URL |
|---|---|
| **Fork (source of truth for PG layer)** | https://github.com/fadheelahmadalfaiz/shoppepay-api-gateway |
| Upstream reference | https://github.com/ahmadzakiyox/shoppepay-api-gateway |
| Live deploy (EasyPanel) | https://app-shoppepay-api-gateway.e3e8hz.easypanel.host/ |
| Platform | **EasyPanel** (Nixpacks), **bukan Dokploy** |

Important commits:
- `1a0a5c9` — feat: PG auto-check layer
- `5b6c8f6` — fix: `npm run build` no-op for Nixpacks (do not reintroduce obfuscator build)

---

## 2) Architecture (must understand before coding)

```
Client / Toko / Bot
        │
        ▼
 Public PORT  ── server.js (PG entrypoint)
   │
   ├── /payments/*     session store + auto-checker + webhook
   │
   └── proxy ────────► CORE_PORT (default 4001)
                         core-gateway.js  (obfuscated upstream core)
                              │
                              ▼
                     ShopeePay Partner unofficial API
                     (token B:..., mutation list, QRIS inject)
```

### Process model
1. `npm start` → runs **`server.js`**
2. `server.js` **spawns** `core-gateway.js` on `CORE_PORT` (internal only)
3. Public app listens on `PORT` (EasyPanel injects this)
4. Auto-checker loop polls pending sessions every `AUTO_CHECK_INTERVAL_MS`

### Files that matter

| Path | Purpose |
|---|---|
| `server.js` | Public PG entry + spawn core + proxy old routes |
| `core-gateway.js` | Obfuscated core (ex-upstream `server.js`) — **do not rewrite** |
| `lib/payment-store.js` | In-memory + JSON file session store, tx claim map |
| `lib/auto-checker.js` | Background poller, webhook, Telegram paid notify |
| `routes/payments.js` | `/payments/*` HTTP API |
| `docs/AUTO-CHECK-PG.md` | Human/operator docs in repo |
| `package.json` | `start=node server.js`, `build=no-op` |
| `.env.example` | All env keys |

### What this is NOT
- Not official ShopeePay API
- No real bank settlement API
- No durable DB by default (JSON file only)
- No multi-tenant SaaS admin UI

---

## 3) Environment variables

### Required (core)
```env
SHOPEE_TOKEN=B:....          # from ShopeePay Partner network token (metadata.token)
API_KEY=....                 # protect public endpoints (header X-API-Key)
QRIS_STATIC=000201...        # EMVCo static QRIS payload string (NOT image)
PORT=4000                    # public (EasyPanel usually injects)
```

### Required for PG mode (defaults OK)
```env
CORE_PORT=4001
AUTO_CHECK_INTERVAL_MS=10000
AUTO_CHECK_MAX_POLLS=120
UNIQUE_AMOUNT=true
PAYMENT_STORE_PATH=./data/payments.json
```

### Optional
```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_CHAT_ID=...
```

### Credential rules for AI
1. **Never invent** `SHOPEE_TOKEN` / `QRIS_STATIC` / `API_KEY`.
2. `QRIS_STATIC` is **decoded raw QR payload** starting with `000201...`, extracted from merchant static QR.
3. `SHOPEE_TOKEN` often dies after logout / force refresh — support `POST /update-token`.
4. Secrets must stay in EasyPanel env, never commit to git.

---

## 4) Auth

All protected endpoints need:

```http
X-API-Key: <API_KEY>
```

or query `?api_key=...` (prefer header).

Optional multi-merchant override:

```http
X-Shopee-Token: B:....
```

---

## 5) Public API contract (PG mode)

Base URL example:
`https://app-shoppepay-api-gateway.e3e8hz.easypanel.host`

### 5.1 Health
```http
GET /api/health
```
Success shape:
```json
{
  "success": true,
  "message": "ShopeePay API Service is running (auto-check PG mode)",
  "mode": "pg-auto-check",
  "core": "http://127.0.0.1:4001",
  "payments": {"total":0,"pending":0,"paid":0,"expired":0,"cancelled":0,"claimed_tx":0},
  "auto_check": {"interval_ms":10000,"max_polls":120,"running":true}
}
```
**Deploy acceptance:** `mode` must be `pg-auto-check`. If message is old core-only text, wrong entrypoint.

### 5.2 Create payment (primary)
```http
POST /payments/create
Content-Type: application/json
X-API-Key: <key>

{
  "amount": 15000,
  "external_id": "ORDER-123",
  "webhook_url": "https://toko.example.com/hooks/shopeepay",
  "metadata": {"user_id": 42, "sku": "VIP-1"}
}
```

Behavior:
1. If `UNIQUE_AMOUNT=true`, charge amount becomes `base + random(1..99)`
2. Calls core `POST /create-qris` with final amount
3. Stores session `status=pending`
4. Starts/continues auto-poll in background
5. Rewrites `qris_url` host to public host (not `127.0.0.1:CORE_PORT`)

Response `201`:
```json
{
  "success": true,
  "data": {
    "payment_id": "pay_...",
    "external_id": "ORDER-123",
    "status": "pending",
    "amount": 15047,
    "base_amount": 15000,
    "unique_suffix": 47,
    "qris_url": "https://public-host/qr/<id>",
    "expires_at": "...",
    "expires_in": "15 menit",
    "startTime": 1710000000,
    "check_url": "/payments/pay_...",
    "auto_check": true,
    "poll_interval_ms": 10000,
    "webhook_url": "https://...",
    "metadata": {}
  }
}
```

### 5.3 Get status
```http
GET /payments/:id
GET /payments/:id?refresh=1
X-API-Key: <key>
```
`refresh=1` forces one immediate check.

### 5.4 Force check / cancel / list
```http
POST /payments/:id/check
POST /payments/:id/cancel
GET  /payments?status=pending&limit=20
```

### 5.5 Payment status machine
```
pending → paid
pending → expired   (time limit or max polls)
pending → cancelled (client cancel)
```

Terminal states: `paid | expired | cancelled`.

### 5.6 Webhook payload (on paid)
```json
{
  "event": "payment.paid",
  "payment_id": "pay_...",
  "external_id": "ORDER-123",
  "amount": 15047,
  "status": "paid",
  "transaction": {
    "transactionId": "...",
    "amount": 15047,
    "status": "success",
    "time": "2026-07-18 19:23:29",
    "issuer": "Gopay"
  },
  "metadata": {},
  "paid_at": "2026-07-18T12:24:01.000Z"
}
```
- Method: `POST` JSON
- Retry: 3 attempts, short backoff
- Receiver should be idempotent on `payment_id` / `transactionId`

---

## 6) Legacy core routes (still proxied)

Keep working for old clients:

| Method | Path | Notes |
|---|---|---|
| POST | `/create-qris` | body `{amount}` |
| POST | `/check-payment` | body `{amount, startTime}` **startTime = unix seconds** |
| GET | `/qr/:id` | QR image/redirect |
| GET | `/transactions` | recent mutations |
| GET | `/transactions/all` | month mutations |
| GET | `/token-status` | token health |
| POST | `/update-token` | body `{token}` |
| GET | `/api/logs` | in-memory logs |

### Critical poll semantics (core)
- Matching is by **exact amount** + **time window from startTime**
- Concurrent same amount can collide → hence `UNIQUE_AMOUNT`
- When paid, always persist `transactionId` in **your** DB too (gateway claim store is best-effort file)

---

## 7) Recommended integration flow (for any bot/webapp)

```text
1. User checkout → your system creates local order (DB)
2. POST /payments/create with:
     amount = order total (integer Rupiah)
     external_id = your order id
     webhook_url = your callback (optional but recommended)
     metadata = anything useful
3. Show data.qris_url to user (or render QR from it)
4. Store payment_id + charged amount (amount, not only base_amount)
5. Wait:
     A) webhook payment.paid  OR
     B) poll GET /payments/:id every 5–15s from your side (optional)
6. On paid:
     - verify amount matches session
     - claim/store transactionId unique
     - mark order PAID
     - fulfill product
7. On expired/cancelled:
     - mark order failed/expired
     - allow recreate payment with new unique amount
```

### Anti double-claim rules (must implement in consumer too)
1. Unique constraint on `transactionId`
2. Unique constraint on `payment_id`
3. Never trust client-only “I paid” claims without gateway status/webhook

---

## 8) EasyPanel deploy checklist

Build settings:
- Builder: **Nixpacks** (or Railpack)
- Install command: empty (auto `npm ci`)
- **Build command: empty OR leave package build no-op**
- Start command: **`npm start`** (must run `server.js`, not core alone)

Env to set in EasyPanel Variables:
```env
SHOPEE_TOKEN=...
API_KEY=...
QRIS_STATIC=...
CORE_PORT=4001
AUTO_CHECK_INTERVAL_MS=10000
AUTO_CHECK_MAX_POLLS=120
UNIQUE_AMOUNT=true
PAYMENT_STORE_PATH=./data/payments.json
TELEGRAM_BOT_TOKEN=...   # optional
TELEGRAM_CHAT_ID=...     # optional
```

Notes:
- Do **not** hardcode public PORT if EasyPanel injects `PORT`
- Ensure volume/persistence for `./data` if you need sessions across restarts (EasyPanel ephemeral FS warning)
- Redeploy after git pull of main

### Known Nixpacks pitfall (fixed)
Old `package.json` build ran:
```bash
javascript-obfuscator server-raw.js ...
```
That fails on deploy (`command not found` / missing source).  
Current build is no-op. **Do not restore obfuscator as `npm run build`.**

---

## 9) Smoke tests (copy-paste)

```bash
BASE="https://app-shoppepay-api-gateway.e3e8hz.easypanel.host"
KEY="YOUR_API_KEY"

# 1 health / mode
curl -sS "$BASE/api/health" | jq '.mode,.auto_check'

# 2 token
curl -sS "$BASE/token-status" -H "X-API-Key: $KEY" | jq

# 3 create payment
curl -sS -X POST "$BASE/payments/create" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" \
  -d '{"amount":1000,"external_id":"SMOKE-1","metadata":{"src":"docs"}}' | jq

# 4 status (replace id)
curl -sS "$BASE/payments/pay_XXX?refresh=1" -H "X-API-Key: $KEY" | jq

# 5 list
curl -sS "$BASE/payments?limit=10" -H "X-API-Key: $KEY" | jq

# 6 legacy mutations
curl -sS "$BASE/transactions" -H "X-API-Key: $KEY" | jq
```

Acceptance criteria:
- [ ] `/api/health` → `mode=pg-auto-check`
- [ ] create returns `payment_id` + `qris_url` public host
- [ ] unauthorized create → 401
- [ ] after real QRIS pay, status becomes `paid` without client calling check-payment
- [ ] same `transactionId` cannot credit two payments

---

## 10) How to get QRIS_STATIC

1. Get merchant **static QRIS** image/sticker from ShopeePay Partner / print material
2. Decode QR to **raw EMV string** (starts `000201...`)
3. Put full single-line string into env `QRIS_STATIC`
4. Not the same as `SHOPEE_TOKEN`

`SHOPEE_TOKEN` = auth to read mutations  
`QRIS_STATIC` = template to generate dynamic amount QR

---

## 11) Extension points for future AI work

When user asks to “integrate into our system / like real PG”, implement **outside** this repo first if possible:

### A. Consumer service (recommended)
- Own DB tables: `orders`, `payments`, `payment_events`
- Call this gateway only as PSP adapter
- Own webhook endpoint + signature (add shared secret if needed)
- Admin UI / bot commands: create invoice, check status, refunds manual

### B. In-repo upgrades (if asked)
1. SQLite/Postgres instead of JSON file
2. Webhook HMAC signature header
3. Admin dashboard routes
4. Multi-merchant config map (token+qris per merchant id)
5. Prometheus metrics / structured logs
6. Rate limit per API key

### C. Do not do unless requested
- Deobfuscate/rewrite `core-gateway.js`
- Change amount matching logic inside core
- Commit real tokens

---

## 12) Suggested DB schema (for consumer system)

```sql
CREATE TABLE payments (
  id              TEXT PRIMARY KEY,          -- local uuid
  gateway_payment_id TEXT UNIQUE,            -- pay_...
  external_order_id  TEXT NOT NULL,
  base_amount     INTEGER NOT NULL,
  charged_amount  INTEGER NOT NULL,          -- includes unique suffix
  status          TEXT NOT NULL,             -- pending|paid|expired|cancelled
  qris_url        TEXT,
  transaction_id  TEXT UNIQUE,
  issuer          TEXT,
  webhook_url     TEXT,
  metadata_json   TEXT,
  paid_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_payments_order ON payments(external_order_id);
CREATE INDEX idx_payments_status ON payments(status);
```

---

## 13) Error catalog (operator + AI)

| Symptom | Cause | Fix |
|---|---|---|
| Deploy: `javascript-obfuscator: not found` | Nixpacks ran old `npm run build` | Ensure commit with build no-op; empty build cmd |
| Health without `pg-auto-check` | Running core only / old image | Start `npm start` / redeploy main |
| Create payment 401 | Wrong/missing API key | Set `X-API-Key` = env `API_KEY` |
| Create fails QRIS | Bad/missing `QRIS_STATIC` | Re-decode static QR payload |
| Always unpaid | Token invalid / amount mismatch / outside window | `/token-status`, use charged amount, check expiry |
| `qris_url` points to 127.0.0.1 | Old bug / proxy headers missing | Current code rewrites via Host/X-Forwarded-*; ensure proxy headers |
| Double fulfill | Consumer ignored unique tx claim | Unique index on transaction_id |
| Token invalid often | Partner session died | Manual `POST /update-token`; monitor Telegram if configured |

---

## 14) Security notes

1. Treat API key as secret; rotate if leaked in chat logs.
2. Unofficial partner token = high risk; isolate service; monitor abuse.
3. Webhook endpoint must verify source (IP allowlist / shared secret if you add it).
4. Do not log full `SHOPEE_TOKEN` / full QRIS payload in public channels.
5. Prefer HTTPS only public base URL.

---

## 15) Minimal Node consumer example

```js
// create + wait (webhook preferred; this is polling fallback)
async function createAndWait({ base, apiKey, amount, orderId, timeoutMs = 15 * 60 * 1000 }) {
  const created = await fetch(`${base}/payments/create`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': apiKey,
    },
    body: JSON.stringify({
      amount,
      external_id: orderId,
      metadata: { orderId },
    }),
  }).then(r => r.json());

  if (!created.success) throw new Error(JSON.stringify(created));
  const paymentId = created.data.payment_id;
  const qrisUrl = created.data.qris_url;
  const charged = created.data.amount;

  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const st = await fetch(`${base}/payments/${paymentId}?refresh=1`, {
      headers: { 'X-API-Key': apiKey },
    }).then(r => r.json());
    const status = st.data?.status;
    if (status === 'paid') return { paymentId, charged, qrisUrl, tx: st.data.transaction };
    if (status === 'expired' || status === 'cancelled') throw new Error(status);
    await new Promise(r => setTimeout(r, 5000));
  }
  throw new Error('timeout');
}
```

---

## 16) Operator quick facts (Faiz context)

- Preferred deploy platform for this app: **EasyPanel**
- GitHub ops often via **Maton.ai** connection (`github` app)
- Fork owner: `fadheelahmadalfaiz`
- Default interaction language with user: **Bahasa Indonesia**, concise, conclusion-first
- When implementing integrations: root-cause → fix → real smoke test → report verdict with evidence

---

## 17) AI task playbooks

### Playbook A — “Integrate into bot X”
1. Read this doc fully
2. Locate bot checkout flow
3. Add config: `SHOPEEPAY_BASE`, `SHOPEEPAY_API_KEY`
4. On checkout call `POST /payments/create`
5. Send QR / `qris_url` to user
6. Implement webhook route OR polling worker
7. Mark order paid only after `status=paid` + store `transactionId`
8. Smoke with amount 1000 first

### Playbook B — “Payment not detected”
1. `GET /api/health` mode check
2. `GET /token-status`
3. Compare charged amount vs paid amount (unique suffix!)
4. Check payment `startTime` / expiry / poll_count / last_error
5. `GET /transactions` for raw mutation
6. If token invalid → update token
7. If mutation exists but not matched → amount/time mismatch

### Playbook C — “Deploy failed on EasyPanel”
1. Confirm builder Nixpacks
2. Confirm `package.json` build is no-op
3. Start command `npm start`
4. Env keys present
5. After deploy, health must show `pg-auto-check`

---

## 18) Glossary

| Term | Meaning |
|---|---|
| Core | Obfuscated gateway talking to Shopee partner endpoints |
| PG layer | Session + auto poll + webhook wrapper |
| Unique amount | base + 1..99 to avoid collision |
| Claim store | Map transactionId → paymentId to prevent double credit |
| QRIS static | Merchant static EMV payload template |
| Auto-check | Server-side polling of `/check-payment` |

---

## 19) Source of truth priority

1. Live behavior of deployed service (`/api/health`, real responses)
2. This document + repo `docs/AUTO-CHECK-PG.md`
3. Code in fork `main`: `server.js`, `routes/payments.js`, `lib/*`
4. Upstream README for core-only semantics

If code and this doc diverge, **trust code + live smoke**, then update docs.

---

## 20) Ready-to-run acceptance prompt for next AI

```text
Integrate ShopeePay PG auto-check from
https://github.com/fadheelahmadalfaiz/shoppepay-api-gateway
using live base URL and API key from env.
Use POST /payments/create, store payment_id + charged amount,
mark order paid only on status=paid with unique transactionId,
prefer webhook payment.paid, fallback poll GET /payments/:id?refresh=1.
Do not call legacy /check-payment from client if PG routes work.
Smoke test health mode=pg-auto-check before coding further.
```

---

*Generated for Hermes/AI handoff. Keep credentials out of git. Prefer real smoke tests over assumed success.*
