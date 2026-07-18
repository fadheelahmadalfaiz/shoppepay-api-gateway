# ShopeePay PG — Integrasi Web App (fokus aplikasi)

> Docs ini **hanya** untuk menyambungkan web app ke gateway.  
> Jangan bahas deploy, arsitektur internal, atau rewrite gateway kecuali diminta.

---

## Base

```text
BASE = https://app-shoppepay-api-gateway.e3e8hz.easypanel.host
Header: X-API-Key: <API_KEY>
```

Env web app:
```env
SHOPEEPAY_BASE_URL=https://app-shoppepay-api-gateway.e3e8hz.easypanel.host
SHOPEEPAY_API_KEY=...
SHOPEEPAY_WEBHOOK_URL=https://fh-event.lovable.app/api/public/shopeepay-webhook
```

---

## Alur yang harus diikuti

```text
User checkout
  → web app simpan order (status=pending)
  → POST /payments/create
  → simpan payment_id + charged_amount (+ qris_url)
  → tampilkan QR ke user
  → tunggu lunas via webhook ATAU poll status
  → status paid → order=paid (simpan transactionId, unique)
  → expired/cancelled → order gagal / boleh buat payment baru
```

**Jangan** pakai legacy `/check-payment` dari web app kalau `/payments/*` sudah jalan.

---

## 1) Buat pembayaran

`POST {BASE}/payments/create`

```json
{
  "amount": 15000,
  "external_id": "ORDER-123",
  "webhook_url": "https://fh-event.lovable.app/api/public/shopeepay-webhook",
  "metadata": {
    "order_id": "ORDER-123",
    "user_id": "42"
  }
}
```

Ambil & simpan:
- `data.payment_id`
- `data.amount` → **ini amount yang harus dibayar** (bisa beda dari request karena +1..99)
- `data.base_amount`
- `data.qris_url`
- `data.expires_at` / `data.expires_in`

Tampilkan `qris_url` ke user (img/QR page).

---

## 2) Cek status (fallback / halaman bayar)

`GET {BASE}/payments/{payment_id}?refresh=1`

Status:
- `pending` → masih menunggu
- `paid` → lunasi order
- `expired` / `cancelled` → hentikan QR, tawarkan buat baru

---

## 3) Webhook (disarankan)

Gateway kirim `POST` ke `webhook_url` saat lunas:

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
  "metadata": { "order_id": "ORDER-123" },
  "paid_at": "2026-07-18T12:24:01.000Z"
}
```

Handler web app:
1. Cari payment/order by `payment_id` / `external_id`
2. Abaikan kalau order sudah `paid` (idempotent)
3. Pastikan `transaction.transactionId` belum pernah dipakai
4. Update order → `paid`
5. Return `200`

---

## 4) Data yang wajib disimpan di web app

| Field | Dari | Kenapa |
|---|---|---|
| `order_id` | app | relasi order |
| `gateway_payment_id` | `payment_id` | cek status / webhook |
| `base_amount` | `base_amount` | harga asli |
| `charged_amount` | `amount` | nominal QR yang dibayar user |
| `qris_url` | `qris_url` | tampil QR |
| `status` | local mirror | pending/paid/expired |
| `transaction_id` | webhook/status | **unique**, anti double credit |

---

## 5) Aturan penting

1. User harus bayar **`charged_amount`**, bukan selalu `base_amount`.
2. Tandai lunas **hanya** jika gateway bilang `paid`.
3. `transaction_id` harus **unique** di DB web app.
4. Satu order bisa punya banyak attempt payment; yang valid hanya yang `paid`.
5. Kalau expired → buat payment baru.

---

## 6) Endpoint lain

| Dipakai? | Endpoint | Kapan |
|---|---|---|
| ✅ utama | `POST /payments/create` | checkout |
| ✅ utama | `GET /payments/:id` | halaman bayar / poll |
| ✅ utama | webhook `payment.paid` | auto lunasi |
| ⚪ opsional | `POST /payments/:id/cancel` | user batal |
| ⚪ opsional | `GET /api/health` | health check |
| ❌ hindari | `POST /check-payment` | legacy |

---

## 7) Checklist

- [ ] Env `SHOPEEPAY_BASE_URL` + `SHOPEEPAY_API_KEY` + `SHOPEEPAY_WEBHOOK_URL`
- [ ] Checkout call `POST /payments/create`
- [ ] Simpan `payment_id` + `charged_amount` + `qris_url`
- [ ] Halaman bayar tampilkan QR + amount benar
- [ ] Webhook idempotent + unique `transaction_id`
- [ ] Poll/refresh status sebagai fallback
- [ ] Smoke: create → bayar kecil → order jadi paid

---

*Fokus: pengaplikasian di web app. Gateway dianggap sudah jalan.*
