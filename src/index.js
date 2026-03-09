require("dotenv").config();
const express = require("express");
const cors = require("cors");
const answerRoute = require("./routes/answer");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get("/", (_req, res) => {
  res.json({ status: "ok", service: "examora-backend", version: "1.0.0" });
});

app.get("/health", (_req, res) => {
  res.json({ status: "healthy" });
});

// API routes
app.use("/api", answerRoute);

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Examora backend running on port ${PORT}`);
});
