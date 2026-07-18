# Auto-Check Payment Gateway Layer
# ================================

Layer di atas core ShopeePay gateway (stateless) supaya toko **tidak perlu** poll manual.

## Kenapa ini ada?

Core asli hanya:
1. `POST /create-qris`
2. Client **poll** `POST /check-payment` tiap 10–15 dtk

Mode PG menambahkan:
1. `POST /payments/create` → buat session + QR + **auto-poll di server**
2. `GET /payments/:id` → cek status kapan saja
3. Webhook `payment.paid` ke URL toko (opsional)
4. Notif Telegram saat lunas (opsional)
5. Anti double-claim `transactionId` (persist ke file)
6. Nominal unik otomatis (`base + 1..99`)

## Arsitektur

```
Public PORT (server.js)
  ├── /payments/*          ← session + auto-check
  └── proxy → Core PORT    ← core-gateway.js (obfuscated asli)
                 └── ShopeePay Partner API
```

- `server.js` = entrypoint PG
- `core-gateway.js` = binary/obfuscated core (ex-`server.js` upstream)
- Core dijalankan di `CORE_PORT` (default 4001, internal)
- Public tetap di `PORT` (default 4000)

## Endpoint baru

### 1) Create payment
```http
POST /payments/create
X-API-Key: <API_KEY>
Content-Type: application/json

{
  "amount": 15000,
  "external_id": "ORDER-123",
  "webhook_url": "https://toko.example.com/hooks/shopeepay",
  "metadata": { "user_id": 42, "sku": "VIP-1" }
}
```

Response:
```json
{
  "success": true,
  "data": {
    "payment_id": "pay_ab12cd34...",
    "status": "pending",
    "amount": 15047,
    "base_amount": 15000,
    "unique_suffix": 47,
    "qris_url": "https://.../qr/xxxx",
    "expires_at": "...",
    "auto_check": true,
    "poll_interval_ms": 10000
  }
}
```

Tampilkan `qris_url` ke pelanggan. Server akan auto-cek mutasi.

### 2) Cek status
```http
GET /payments/pay_ab12cd34
X-API-Key: <API_KEY>

# force check sekarang:
GET /payments/pay_ab12cd34?refresh=1
```

### 3) Force check
```http
POST /payments/pay_ab12cd34/check
X-API-Key: <API_KEY>
```

### 4) Cancel
```http
POST /payments/pay_ab12cd34/cancel
X-API-Key: <API_KEY>
```

### 5) List
```http
GET /payments?status=pending&limit=20
X-API-Key: <API_KEY>
```

## Webhook payload (saat lunas)

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
  "metadata": { "user_id": 42 },
  "paid_at": "2026-07-18T12:24:01.000Z"
}
```

Retry: 3x, backoff pendek. Simpan `transactionId` di DB toko juga (defense in depth).

## Env baru

| Key | Default | Keterangan |
|---|---|---|
| `CORE_PORT` | `4001` | port internal core |
| `AUTO_CHECK_INTERVAL_MS` | `10000` | interval poll |
| `AUTO_CHECK_MAX_POLLS` | `120` | max poll (~20 mnt) |
| `UNIQUE_AMOUNT` | `true` | +1..99 anti tabrakan |
| `PAYMENT_STORE_PATH` | `./data/payments.json` | persist session |

## Contoh cURL

```bash
BASE=https://your-host
KEY=your_api_key

# create
curl -sS -X POST "$BASE/payments/create" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: $KEY" \
  -d '{"amount":1000,"external_id":"TEST-1","webhook_url":"https://webhook.site/xxx"}' | jq

# status
curl -sS "$BASE/payments/pay_xxx?refresh=1" -H "X-API-Key: $KEY" | jq
```

## Catatan penting

1. Ini **unofficial** — token partner Shopee bisa mati kapan saja.
2. Tetap simpan `transactionId` di DB toko (jangan andalkan file/RAM saja).
3. Endpoint lama (`/create-qris`, `/check-payment`, ...) **tetap hidup** via proxy.
4. EasyPanel/Railway: start command = `npm start` (menjalankan `server.js` baru).
