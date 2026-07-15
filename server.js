"use strict";
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const axios = require("axios");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 4000;

// ── Global Config & State ───────────────────────────────────────────────────
let shopeeToken = process.env.SHOPEE_TOKEN || "";
const apiKey = process.env.API_KEY || "";
const telegramBotToken = process.env.TELEGRAM_BOT_TOKEN || "";
const telegramChatID = process.env.TELEGRAM_CHAT_ID || "";
const qrisStatic = process.env.QRIS_STATIC || "";

const qrisStore = new Map(); // id -> { data, expiresAt }
let tokenValid = true;
let tokenNotifSent = false;

const logs = [];
const MAX_LOGS = 100;

function logEvent(level, message) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] [${level}] ${message}`);
  logs.push({ timestamp, level, message });
  if (logs.length > MAX_LOGS) {
    logs.shift();
  }
}

// Pool of realistic user agents to rotate (matching Go version)
const userAgents = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:127.0) Gecko/20100101 Firefox/127.0",
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36 Edg/124.0.0.0",
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
];

function randomUA() {
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

const statusMap = {
  1: "pending",
  2: "failed",
  3: "success",
  4: "refunded",
  5: "expired",
};

// ── Express Middleware ───────────────────────────────────────────────────────
app.use(cors({ origin: "*", credentials: true }));
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));

function apiKeyMiddleware(req, res, next) {
  let key = req.headers["x-api-key"] || req.query.api_key;
  if (!key || key !== apiKey) {
    return res.status(401).json({ success: false, error: "Invalid or missing API key" });
  }
  next();
}

// ── Helper Functions ─────────────────────────────────────────────────────────
function formatTransaction(t) {
  const date = new Date(t.createTime * 1000);
  // Convert to UTC+7 (WIB)
  const offset = 7 * 60; // minutes
  const wibTime = new Date(date.getTime() + offset * 60 * 1000);

  const pad = (n) => String(n).padStart(2, "0");
  const formattedTime = `${wibTime.getUTCFullYear()}-${pad(wibTime.getUTCMonth() + 1)}-${pad(wibTime.getUTCDate())} ${pad(wibTime.getUTCHours())}:${pad(wibTime.getUTCMinutes())}:${pad(wibTime.getUTCSeconds())}`;

  let cleanAmount = String(t.amount || "0").replace(/\./g, "").replace(/,/g, "");
  const amount = parseInt(cleanAmount, 10) || 0;

  let status = statusMap[t.status] || `unknown_${t.status}`;

  return {
    amount,
    status,
    time: formattedTime,
  };
}
function getReqToken(req) {
  return req.headers["x-shopee-token"] || shopeeToken;
}

async function callShopeeAPI(startTime, endTime, pageSize, nextPos, token = shopeeToken) {
  const payload = {
    data: {
      metadata: {
        token: token,
        language: "id",
        timezone: "Asia/Jakarta",
      },
      pageSize: pageSize,
      filter: {
        startTime: startTime,
        endTime: endTime,
        serviceList: [1, 3],
      },
      sorter: {
        field: "createTime",
        order: "descend",
      },
      next_position: nextPos || "",
    },
  };

  const headers = {
    "Content-Type": "application/json",
    Origin: "https://partner.shopee.co.id",
    Referer: "https://partner.shopee.co.id/",
    "User-Agent": randomUA(),
    "X-Timestamp-Ms": String(Date.now()),
  };

  const response = await axios.post(
    "https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-list",
    payload,
    { headers, timeout: 20000 }
  );

  return response.data;
}

async function callShopeeDetailAPI(orderSN, token = shopeeToken) {
  const payload = {
    data: {
      metadata: {
        token: token,
        language: "id",
        timezone: "Asia/Jakarta",
      },
      order_sn: orderSN,
    },
  };

  const headers = {
    "Content-Type": "application/json",
    Origin: "https://partner.shopee.co.id",
    Referer: "https://partner.shopee.co.id/",
    "User-Agent": randomUA(),
    "X-Timestamp-Ms": String(Date.now()),
  };

  const response = await axios.post(
    "https://shopeepay.shopee.co.id/merchant/v1/partner-web/get-transaction-detail",
    payload,
    { headers, timeout: 20000 }
  );

  return response.data;
}

async function sendTelegramNotif(message) {
  if (!telegramBotToken || !telegramChatID) {
    console.log("[TELEGRAM] Bot token atau chat ID belum diset");
    return;
  }

  const url = `https://api.telegram.org/bot${telegramBotToken}/sendMessage`;
  try {
    await axios.post(url, {
      chat_id: telegramChatID,
      text: message,
      parse_mode: "HTML",
    }, { timeout: 10000 });
    console.log("[TELEGRAM] Notif sent");
  } catch (err) {
    console.error("[TELEGRAM] Send failed:", err.message);
  }
}

// ── QRIS Parsing and Generation (EMVCo TLV & CRC16-CCITT) ─────────────────────
function parseTLV(data) {
  const result = [];
  let i = 0;
  while (i < data.length) {
    if (i + 4 > data.length) break;
    const tag = data.slice(i, i + 2);
    const length = parseInt(data.slice(i + 2, i + 4), 10);
    if (isNaN(length)) break;
    i += 4;
    if (i + length > data.length) break;
    const value = data.slice(i, i + length);
    i += length;
    result.push([tag, value]);
  }
  return result;
}

function buildTLV(fields) {
  let res = "";
  for (const f of fields) {
    const tag = f[0];
    const val = f[1];
    res += tag + String(val.length).padStart(2, "0") + val;
  }
  return res;
}

function crc16CCITT(data) {
  let crc = 0xFFFF;
  for (let i = 0; i < data.length; i++) {
    crc ^= data.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) {
      if (crc & 0x8000) {
        crc = ((crc << 1) ^ 0x1021) & 0xFFFF;
      } else {
        crc = (crc << 1) & 0xFFFF;
      }
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

function generateDynamicQRIS(staticQRIS, amount) {
  if (!staticQRIS) {
    throw new Error("QRIS_STATIC belum diset di .env");
  }

  const fields = parseTLV(staticQRIS);
  if (fields.length === 0) {
    throw new Error("invalid QRIS format");
  }

  const newFields = [];
  let hasAmount = false;
  for (const f of fields) {
    if (f[0] === "63") continue; // skip CRC, will recalculate
    if (f[0] === "54") {
      newFields.push(["54", String(amount)]);
      hasAmount = true;
      continue;
    }
    newFields.push(f);
  }

  if (!hasAmount) {
    const withAmount = [];
    for (const f of newFields) {
      withAmount.push(f);
      if (f[0] === "53") {
        withAmount.push(["54", String(amount)]);
      }
    }
    newFields.length = 0;
    newFields.push(...withAmount);
  }

  let qrisWithoutCRC = buildTLV(newFields);
  qrisWithoutCRC += "6304";
  const crc = crc16CCITT(qrisWithoutCRC);
  return qrisWithoutCRC + crc;
}

// ── Background Token Checker ─────────────────────────────────────────────────
async function checkToken() {
  const now = Math.floor(Date.now() / 1000);
  const startTime = now - 3600; // last 1 hour
  const endTime = now;

  try {
    const result = await callShopeeAPI(startTime, endTime, 1, "");
    if (!result || result.code !== 0) {
      const msg = result ? result.msg : "Invalid response format";
      logEvent("ERROR", `Token invalid: ${msg}`);
      tokenValid = false;
      if (!tokenNotifSent) {
        await sendTelegramNotif(`⚠️ <b>Shopee API</b>\n\nToken invalid: ${msg}\n\nUpdate token via POST /update-token`);
        tokenNotifSent = true;
      }
      return;
    }
    logEvent("INFO", "Token valid");
    tokenValid = true;
    tokenNotifSent = false;
  } catch (err) {
    logEvent("ERROR", `Token check failed: ${err.message}`);
    tokenValid = false;
    if (!tokenNotifSent) {
      await sendTelegramNotif(`⚠️ <b>Shopee API</b>\n\nToken error: ${err.message}\n\nUpdate token via POST /update-token`);
      tokenNotifSent = true;
    }
  }
}

function startTokenChecker() {
  // Check immediately on startup
  checkToken();
  // Check every 5 minutes
  setInterval(checkToken, 5 * 60 * 1000);
}

// ── API Endpoints ────────────────────────────────────────────────────────────

// GET /api/health (Basic status check)
app.get("/api/health", (req, res) => {
  res.json({
    success: true,
    message: "ShopeePay API Service is running",
    timestamp: new Date().toISOString()
  });
});

// POST /update-token - Update shopeeToken in-memory
app.post("/update-token", apiKeyMiddleware, (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ success: false, error: "Provide token in body" });
  }
  shopeeToken = token;
  logEvent("INFO", "Token updated via API");
  res.json({
    success: true,
    data: { message: "Token updated" }
  });
});

// GET /token-status - Check token validation status
app.get("/token-status", apiKeyMiddleware, (req, res) => {
  const status = tokenValid ? "valid" : "invalid";
  res.json({
    success: tokenValid,
    data: {
      token_status: status,
      message: tokenValid
        ? "Token is working"
        : "Token expired/invalid. Please update via POST /update-token",
    },
  });
});

// POST /create-qris - Generate dynamic QRIS
app.post("/create-qris", apiKeyMiddleware, (req, res) => {
  const { amount } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, error: "Provide valid amount (positive integer)" });
  }

  try {
    const qris = generateDynamicQRIS(qrisStatic, amount);
    const id = crypto.randomBytes(4).toString("hex"); // 8 hex characters
    const expiresAt = new Date(Date.now() + 15 * 60 * 1000); // 15 mins expiry
    
    qrisStore.set(id, {
      data: qris,
      expiresAt: expiresAt,
    });

    const host = req.get("host");
    const scheme = req.protocol;
    const qrURL = `${scheme}://${host}/qr/${id}`;

    // Format to WIB: YYYY-MM-DD HH:mm:ss
    const offset = 7 * 60; // UTC+7
    const wibTime = new Date(expiresAt.getTime() + offset * 60 * 1000);
    const pad = (n) => String(n).padStart(2, "0");
    const formattedExpiresAt = `${wibTime.getUTCFullYear()}-${pad(wibTime.getUTCMonth() + 1)}-${pad(wibTime.getUTCDate())} ${pad(wibTime.getUTCHours())}:${pad(wibTime.getUTCMinutes())}:${pad(wibTime.getUTCSeconds())}`;

    res.json({
      success: true,
      data: {
        qris_url: qrURL,
        amount: amount,
        expires_at: formattedExpiresAt,
        expires_in: "15 menit",
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /qr/:id - Public QR redirect to image server
app.get("/qr/:id", (req, res) => {
  const id = req.params.id;
  const entry = qrisStore.get(id);
  if (!entry) {
    return res.status(404).send("QR not found");
  }
  if (Date.now() > entry.expiresAt.getTime()) {
    qrisStore.delete(id);
    return res.status(410).send("QR expired");
  }

  const qrAPIURL = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(entry.data)}`;
  res.redirect(302, qrAPIURL);
});

// GET /transactions - Fetch latest transactions
app.get("/transactions", apiKeyMiddleware, async (req, res) => {
  const now = Math.floor(Date.now() / 1000);
  let startTime = parseInt(req.query.startTime, 10);
  let endTime = parseInt(req.query.endTime, 10);
  let pageSize = parseInt(req.query.pageSize, 10);
  const nextPos = req.query.next_position || "";

  if (isNaN(startTime) || startTime === 0) {
    startTime = now - 3 * 24 * 3600; // default 3 days
  }
  if (isNaN(endTime) || endTime === 0) {
    endTime = now;
  }
  if (isNaN(pageSize) || pageSize === 0) {
    pageSize = 10;
  }

  const reqToken = getReqToken(req);

  try {
    const result = await callShopeeAPI(startTime, endTime, pageSize, nextPos, reqToken);
    if (!result) {
      return res.status(500).json({ success: false, error: "Empty response from ShopeePay API" });
    }
    if (result.code !== 0) {
      return res.status(400).json({ success: false, error: result.msg || `API error code ${result.code}` });
    }

    const list = (result.data && result.data.list) || [];
    const formatted = [];

    for (const t of list) {
      const trx = formatTransaction(t);
      try {
        const detail = await callShopeeDetailAPI(t.displayTransactionId || t.transactionId, reqToken);
        if (detail && detail.code === 0 && detail.data) {
          trx.issuer = detail.data.issuer;
        }
      } catch (err) {
        logEvent("ERROR", `Error checking detail for ${t.transactionId}: ${err.message}`);
      }
      formatted.push(trx);
    }

    res.json({
      success: true,
      total_amount: (result.data && result.data.totalNetSales) || "0",
      data: {
        transactions: formatted,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /transactions/all - Fetch all transactions of the month (auto-paginated)
app.get("/transactions/all", apiKeyMiddleware, async (req, res) => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();

  // startOfMonth in WIB (UTC+7)
  const startOfMonth = new Date(Date.UTC(year, month, 1, 0, 0, 0) - 7 * 60 * 60 * 1000);
  const startTime = Math.floor(startOfMonth.getTime() / 1000);
  const endTime = Math.floor(now.getTime() / 1000);

  const allTrx = [];
  let nextPos = "";
  const pageSize = 100;

  const reqToken = getReqToken(req);

  try {
    while (true) {
      const result = await callShopeeAPI(startTime, endTime, pageSize, nextPos, reqToken);
      if (!result) {
        return res.status(500).json({ success: false, error: "Empty response from ShopeePay API" });
      }
      if (result.code !== 0) {
        return res.status(400).json({ success: false, error: result.msg || `API error code ${result.code}` });
      }

      const list = (result.data && result.data.list) || [];
      for (const t of list) {
        const trx = formatTransaction(t);
        try {
          const detail = await callShopeeDetailAPI(t.displayTransactionId || t.transactionId, reqToken);
          if (detail && detail.code === 0 && detail.data) {
            trx.issuer = detail.data.issuer;
          }
        } catch (err) {
          logEvent("ERROR", `Error checking detail for ${t.transactionId}: ${err.message}`);
        }
        allTrx.push(trx);
      }

      if (!result.data || !result.data.next_position || list.length < pageSize) {
        break;
      }
      nextPos = result.data.next_position;

      // Rate limit spacer (500ms)
      await new Promise((resolve) => setTimeout(resolve, 500));
    }

    const pad = (n) => String(n).padStart(2, "0");
    const startWIB = new Date(startOfMonth.getTime() + 7 * 60 * 60 * 1000);
    const endWIB = new Date(now.getTime() + 7 * 60 * 60 * 1000);
    const periodStr = `${startWIB.getUTCFullYear()}-${pad(startWIB.getUTCMonth() + 1)}-${pad(startWIB.getUTCDate())} s/d ${endWIB.getUTCFullYear()}-${pad(endWIB.getUTCMonth() + 1)}-${pad(endWIB.getUTCDate())}`;

    res.json({
      success: true,
      total_amount: String(allTrx.length),
      data: {
        period: periodStr,
        total_count: allTrx.length,
        transactions: allTrx,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /check-payment - Verifikasi pembayaran secara stateless (real-time query)
app.post("/check-payment", apiKeyMiddleware, async (req, res) => {
  const { amount, startTime } = req.body;
  if (!amount || amount <= 0) {
    return res.status(400).json({ success: false, error: "Provide valid amount (positive integer)" });
  }

  const reqToken = getReqToken(req);
  const nowUnix = Math.floor(Date.now() / 1000);
  
  // Jika startTime tidak disediakan, default ke 30 menit ke belakang
  let startUnix = parseInt(startTime, 10);
  if (isNaN(startUnix) || startUnix === 0) {
    startUnix = nowUnix - 30 * 60; 
  }

  logEvent("INFO", `Memulai pengecekan pembayaran stateless. Nominal: Rp ${amount}, Waktu Mulai: ${new Date(startUnix * 1000).toISOString()}`);

  try {
    const result = await callShopeeAPI(startUnix, nowUnix, 50, "", reqToken);
    if (!result) {
      logEvent("ERROR", "Respons dari ShopeePay API kosong.");
      return res.status(500).json({ success: false, error: "Empty response from ShopeePay API" });
    }
    if (result.code !== 0) {
      logEvent("ERROR", `API ShopeePay mengembalikan kode ${result.code}: ${result.msg}`);
      return res.status(400).json({ success: false, error: result.msg || `API error code ${result.code}` });
    }

    const list = (result.data && result.data.list) || [];
    const expectedAmount = Number(amount);

    // Cari transaksi sukses (status 3) dengan nominal cocok
    const match = list.find((tx) => {
      const cleanAmount = String(tx.amount || "0").replace(/\./g, "").replace(/,/g, "");
      const txAmount = parseInt(cleanAmount, 10) || 0;
      return tx.status === 3 && txAmount === expectedAmount && tx.createTime >= startUnix;
    });

    if (!match) {
      logEvent("INFO", `Pengecekan selesai. Nominal Rp ${amount} BELUM ditemukan.`);
      return res.json({
        success: true,
        paid: false
      });
    }

    logEvent("INFO", `Pencocokan berhasil! Transaksi ditemukan: ${match.transactionId}. Mengambil detail...`);

    const trx = formatTransaction(match);
    try {
      const detail = await callShopeeDetailAPI(match.displayTransactionId || match.transactionId, reqToken);
      if (detail && detail.code === 0 && detail.data) {
        trx.issuer = detail.data.issuer;
      }
    } catch (err) {
      logEvent("WARN", `Gagal mengambil detail transaksi ${match.transactionId}: ${err.message}`);
    }

    logEvent("INFO", `Pembayaran terverifikasi lunas via ${trx.issuer || "ShopeePay/QRIS"}.`);

    res.json({
      success: true,
      paid: true,
      transaction: {
        transactionId: match.transactionId || match.displayTransactionId,
        amount: trx.amount,
        status: trx.status,
        time: trx.time,
        issuer: trx.issuer || "QRIS / ShopeePay"
      }
    });

  } catch (err) {
    logEvent("ERROR", `Pengecekan gagal karena exception: ${err.message}`);
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/logs - Mengambil in-memory circular logs
app.get("/api/logs", apiKeyMiddleware, (req, res) => {
  res.json({
    success: true,
    data: {
      logs: logs
    }
  });
});

// ── Server Listen & Startup ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`ShopeePay API (express) running at http://localhost:${PORT}`);
  console.log("Endpoints:");
  console.log("  POST /update-token       - Update ShopeeToken");
  console.log("  GET  /token-status       - Check ShopeeToken Validity status");
  console.log("  POST /create-qris        - Generate Dynamic QRIS from static template");
  console.log("  GET  /qr/:id             - Fetch Dynamic QRIS Image Redirect");
  console.log("  GET  /transactions       - Fetch transactions list");
  console.log("  GET  /transactions/all   - Fetch all transactions of the month");
  
  if (shopeeToken && apiKey) {
    startTokenChecker();
  } else {
    console.warn("WARNING: SHOPEE_TOKEN and API_KEY must be set in .env to run checks.");
  }
});
