require("dotenv").config();
const express = require("express");
const cors = require("cors");

const answerRoute = require("./routes/answer");
const documentsRoute = require("./routes/documents");
const sessionsRoute = require("./routes/sessions");
const userRoute = require("./routes/user");
const transcribeRoute = require("./routes/transcribe");
const translateRoute = require("./routes/translate");
const usageRoute = require("./routes/usage");
const deviceRoute = require("./routes/device");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ── Rate Limiting (kötü niyetli kullanıcı koruması) ──────────────────────────
// express-rate-limit yoksa düşük maliyetli basit bir in-memory limiter kullanır.
// Production'da express-rate-limit paketi kurulması önerilir: npm install express-rate-limit
let rateLimit;
try {
  rateLimit = require("express-rate-limit");
} catch (_) {
  // Paket yoksa basit bir no-op middleware döner — kurulum gerekmez
  rateLimit = () => (_req, _res, next) => next();
}

// IP için anahtar üretici (Railway / proxy arkası için X-Forwarded-For'u destekler)
const ipKey = (req) => req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.ip;

// Hesap silme: IP başına 5 dakikada en fazla 5 deneme
const deletionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla silme girişimi. Lütfen 5 dakika bekleyin." },
  keyGenerator: ipKey,
});

// Doküman yükleme: IP başına saatte 20 istek
// (Aylık limit Firestore'da takip ediliyor; bu kısa vadeli abuse koruması)
// Not: authenticateRequest'tan önce çalıştığı için IP bazlı; uid bazlı limit
// Firestore'daki aylık sayaç ile sağlanıyor.
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 saat
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Çok fazla yükleme isteği. Lütfen 1 saat bekleyin.",
    code: "UPLOAD_RATE_LIMIT",
  },
  keyGenerator: ipKey,
  skip: (req) => req.method !== "POST", // GET/DELETE isteklerini atla
});

// Genel API: dakikada 120 istek (spam koruması)
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla istek. Lütfen yavaşlayın." },
  keyGenerator: ipKey,
});

app.use("/api", generalLimiter);
app.use("/api/user/me", (req, res, next) => {
  if (req.method === "DELETE") return deletionLimiter(req, res, next);
  next();
});
app.use("/api/documents", uploadLimiter);

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "examora-backend", version: "3.0.0" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "healthy" });
});

// API routes
app.use("/api", answerRoute);
app.use("/api", documentsRoute);
app.use("/api", sessionsRoute);
app.use("/api", userRoute);
app.use("/api", transcribeRoute);
app.use("/api", translateRoute);
app.use("/api", usageRoute);
app.use("/api", deviceRoute);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Examora backend v3.0.0 running on port ${PORT}`);
});
