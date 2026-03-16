const express = require("express");
const multer = require("multer");
const { authenticateRequest } = require("../middleware/auth");
const { transcribeAudio } = require("../services/azureOpenai");
const path = require("path");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

/**
 * POST /api/transcribe
 * Body: multipart with "audio" file (mp3, wav, m4a, etc.)
 * Returns: { text: "transcribed text" }
 */
router.post("/transcribe", authenticateRequest, upload.single("audio"), async (req, res) => {
  try {
    const file = req.file;
    if (!file || !file.buffer || file.buffer.length < 1000) {
      return res.status(400).json({ error: "Audio file missing or too short" });
    }

    const ext = path.extname(file.originalname || "").slice(1) || "wav";
    const text = await transcribeAudio(file.buffer, ext);
    res.json({ text: text || "" });
  } catch (err) {
    console.error("Transcribe error:", err.message);
    // SECURITY: Never expose internal error details to the client
    const detail = process.env.NODE_ENV === "production" ? undefined : err.message;
    res.status(500).json({ error: "Transcription failed", ...(detail && { detail }) });
  }
});

module.exports = router;
