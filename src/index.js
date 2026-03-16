require("dotenv").config();
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

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

// ── Security Headers (helmet) ──────────────────────────────────────────────
app.use(helmet());

// ── Trust Proxy ────────────────────────────────────────────────────────────
// Railway (and similar PaaS) runs behind a reverse proxy.
// Trust only the first proxy hop to prevent X-Forwarded-For spoofing.
app.set("trust proxy", 1);

// ── CORS ───────────────────────────────────────────────────────────────────
// Restrict origins to known domains. Mobile apps don't need CORS, but if
// a web dashboard is added later, add its origin here.
const ALLOWED_ORIGINS = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  cors({
    origin: ALLOWED_ORIGINS.length > 0
      ? (origin, callback) => {
          // Allow requests with no origin (mobile apps, curl, etc.)
          if (!origin) return callback(null, true);
          if (ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
          callback(new Error("CORS policy: origin not allowed"));
        }
      : false, // If no origins configured, disable CORS entirely (mobile-only API)
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization", "X-Device-Id", "X-Api-Key", "X-Localization-Key"],
  })
);

// ── Body Parser with Size Limits ───────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));

// ── Rate Limiting ──────────────────────────────────────────────────────────
// Uses req.ip (reliable because trust proxy is set above)

// Hesap silme: IP başına 5 dakikada en fazla 5 deneme
const deletionLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla silme girişimi. Lütfen 5 dakika bekleyin." },
});

// Doküman yükleme: IP başına saatte 20 istek
const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    error: "Çok fazla yükleme isteği. Lütfen 1 saat bekleyin.",
    code: "UPLOAD_RATE_LIMIT",
  },
  skip: (req) => req.method !== "POST",
});

// Genel API: dakikada 120 istek (spam koruması)
const generalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Çok fazla istek. Lütfen yavaşlayın." },
});

app.use("/api", generalLimiter);
app.use("/api/user/me", (req, res, next) => {
  if (req.method === "DELETE") return deletionLimiter(req, res, next);
  next();
});
app.use("/api/documents", uploadLimiter);

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "examora-backend", version: "3.1.0" });
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

// ── Global Error Handler ───────────────────────────────────────────────────
// Catch unhandled errors and prevent stack trace leakage
app.use((err, _req, res, _next) => {
  // CORS errors
  if (err.message && err.message.includes("CORS policy")) {
    return res.status(403).json({ error: "Origin not allowed" });
  }
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

app.listen(PORT, "0.0.0.0", () => {
  // Startup validation: warn about missing critical env vars
  const requiredEnvVars = ["AZURE_OPENAI_API_KEY", "AZURE_OPENAI_ENDPOINT", "AZURE_STORAGE_CONNECTION_STRING"];
  const missing = requiredEnvVars.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    console.warn(`⚠️  Missing environment variables: ${missing.join(", ")}`);
  }
  if (!process.env.API_KEY) {
    console.warn("⚠️  API_KEY not set — API key authentication is disabled for anonymous requests");
  }
  if (!process.env.ADMIN_UIDS) {
    console.warn("⚠️  ADMIN_UIDS not set — admin /user/role endpoint is disabled");
  }
  console.log(`Examora backend v3.1.0 running on port ${PORT}`);
});
