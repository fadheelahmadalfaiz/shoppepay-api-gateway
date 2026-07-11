# ShopeePay Verified Callback & Verification Gateway

Layanan monitoring, pengecekan, dan otomatisasi verifikasi transaksi QRIS ShopeePay Merchant berbasis Web API.

Sistem ini memantau mutasi secara real-time ke partner portal ShopeePay, mendeteksi pembayaran masuk sesuai nominal tagihan (+kode unik), dan mengirimkan HTTP POST webhook (callback) ke web utama Anda secara instan.

## 🛠️ Environment Variables (.env)

Buat file `.env` di root folder dan masukkan konfigurasi berikut:

```env
# JWT Token dari cookie __shopee_partner_website_x_token_live (Capture/Sniff)
SHOPEEPAY_TOKEN="eyJhbGciOiJ..."

# QRIS Statis utama toko Anda (opsional, untuk generator dynamic QRIS)
SHOPEEPAY_QRIS_STRING="0002010102112661..."

# Port server berjalan
PORT=3001

# Password untuk dashboard admin gateway
ADMIN_PASSWORD="admin_secret_kamu"

# URL Tujuan callback webhook ketika pembayaran berhasil dicocokkan
CALLBACK_URL="https://web-toko-kamu.com/api/webhook/shoppepay"

# Lokasi penyimpanan file database SQLite (Gunakan ini jika di-host di cloud)
DB_PATH="./data.db"
```

---

## 💻 Jalankan Lokal (Development)

1.  Clone atau download repository ini.
2.  Install dependensi:
    ```bash
    npm install
    ```
3.  Jalankan server:
    ```bash
    npm start
    ```
4.  Buka dashboard monitor lokal di browser: `http://localhost:3001` (login menggunakan `ADMIN_PASSWORD` Anda).

---

## 🚀 Cara Host / Deploy di Render.com

Agar server ini menyala 24 jam di cloud dan terus memantau transaksi, Anda bisa meng-host-nya secara gratis/berbayar di **Render.com**:

### Langkah 1: Buat Web Service Baru
1.  Masuk ke dashboard **Render.com** dan hubungkan akun GitHub Anda.
2.  Klik **New +** -> **Web Service**.
3.  Pilih repository **`Shoppepay-Callback`** Anda.

### Langkah 2: Konfigurasi Build & Run
*   **Name:** `shoppepay-gateway` (bebas)
*   **Environment / Runtime:** `Node`
*   **Build Command:** `npm install`
*   **Start Command:** `node server.js`

### Langkah 3: Tambahkan Environment Variables
Klik menu **Environment** di Render dan tambahkan variable sesuai kebutuhan:
*   `SHOPEEPAY_TOKEN` = *(Token JWT Shopee Anda)*
*   `ADMIN_PASSWORD` = *(Password Admin Anda)*
*   `CALLBACK_URL` = `https://domain-toko-utama-anda.com/api/webhook/shoppepay`
*   `DB_PATH` = `/data/data.db` *(PENTING: Harus diletakkan di folder persistent volume `/data`)*

### Langkah 4: Tambahkan Persistent Disk (PENTING! agar data database tidak terhapus)
Layanan Render gratis/berbayar akan merestart server secara berkala. Agar database SQLite (`data.db`) tidak hilang saat server restart:
1.  Buka menu **Disks** di sebelah kiri dashboard Render Web Service Anda.
2.  Klik **Add Disk**.
3.  Konfigurasikan Disk:
    *   **Name:** `shoppepay-db-disk`
    *   **Mount Path:** `/data` *(Ini harus sama dengan prefix folder di `DB_PATH`)*
    *   **Size:** `1 GiB` (Sangat cukup untuk menyimpan ribuan log log transaksi).
4.  Klik **Save**.

Render akan mem-build ulang proyek Anda. Sekarang gateway ShopeePay Anda telah aktif secara mandiri di cloud Render, aman dari restart server, dan siap mengirimkan callback ke website utama!
