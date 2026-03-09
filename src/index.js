require("dotenv").config();
const express = require("express");
const cors = require("cors");

const answerRoute = require("./routes/answer");
const documentsRoute = require("./routes/documents");
const sessionsRoute = require("./routes/sessions");
const userRoute = require("./routes/user");
const transcribeRoute = require("./routes/transcribe");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

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

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Examora backend v3.0.0 running on port ${PORT}`);
});
