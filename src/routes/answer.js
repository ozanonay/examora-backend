const express = require("express");
const multer = require("multer");
const { validateApiKey } = require("../middleware/auth");
const { transcribeAudio, generateAnswer } = require("../services/azureOpenai");
const { extractTextFromBlob } = require("../services/blobStorage");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post("/answer", validateApiKey, upload.single("audio"), async (req, res) => {
  try {
    const audioFile = req.file;
    const { specialty, context, sessionId, documentBlobName } = req.body;

    if (!audioFile || !audioFile.buffer || audioFile.buffer.length < 1000) {
      return res.status(400).json({ error: "Audio file is missing or too short" });
    }

    if (!specialty) {
      return res.status(400).json({ error: "Specialty field is required" });
    }

    console.log(`[${sessionId || "no-session"}] Processing: ${specialty}, audio ${(audioFile.buffer.length / 1024).toFixed(0)}KB`);

    // 1. Transcribe audio → detected question
    const detectedQuestion = await transcribeAudio(audioFile.buffer);

    if (!detectedQuestion || detectedQuestion.trim().length < 3) {
      return res.status(422).json({ error: "Could not detect speech. Please speak more clearly." });
    }

    console.log(`[${sessionId || "no-session"}] Question: "${detectedQuestion.substring(0, 80)}..."`);

    // 2. If a specialty PDF is selected, extract its text
    let documentContext = "";
    if (documentBlobName) {
      try {
        console.log(`[${sessionId || "no-session"}] Loading document: ${documentBlobName}`);
        documentContext = await extractTextFromBlob(documentBlobName);
        console.log(`[${sessionId || "no-session"}] Document loaded: ${documentContext.length} chars`);
      } catch (err) {
        console.warn(`[${sessionId || "no-session"}] Document load failed: ${err.message}`);
      }
    }

    // 3. Generate answer (Azure OpenAI GPT + document context)
    const { turkishAnswer, englishAnswer } = await generateAnswer({
      question: detectedQuestion,
      specialty,
      context: context || "",
      documentContext,
    });

    // 4. Return response (snake_case for iOS)
    res.json({
      detected_question: detectedQuestion,
      turkish_answer: turkishAnswer,
      english_answer: englishAnswer,
    });
  } catch (err) {
    console.error("Answer endpoint error:", err.message);

    if (err.status === 429) {
      return res.status(429).json({ error: "Rate limit exceeded. Please try again." });
    }

    res.status(500).json({ error: "Internal server error" });
  }
});

module.exports = router;
