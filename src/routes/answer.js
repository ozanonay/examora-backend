const express = require("express");
const multer = require("multer");
const { authenticateRequest } = require("../middleware/auth");
const { canUseDocuments } = require("../services/firebase");
const { transcribeAudio, generateAnswer } = require("../services/azureOpenai");
const { extractTextFromBlob, saveExamSession } = require("../services/blobStorage");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post("/answer", authenticateRequest, upload.single("audio"), async (req, res) => {
  try {
    const audioFile = req.file;
    const { specialty, context, sessionId, documentBlobName } = req.body;
    const user = req.user;

    if (!audioFile || !audioFile.buffer || audioFile.buffer.length < 1000) {
      return res.status(400).json({ error: "Audio file is missing or too short" });
    }

    if (!specialty) {
      return res.status(400).json({ error: "Specialty field is required" });
    }

    console.log(`[${user.uid}/${sessionId || "no-session"}] Processing: ${specialty}, audio ${(audioFile.buffer.length / 1024).toFixed(0)}KB`);

    // 1. Transcribe audio
    const detectedQuestion = await transcribeAudio(audioFile.buffer);

    if (!detectedQuestion || detectedQuestion.trim().length < 3) {
      return res.status(422).json({ error: "Could not detect speech. Please speak more clearly." });
    }

    console.log(`[${user.uid}] Question: "${detectedQuestion.substring(0, 80)}..."`);

    // 2. Load document context if selected and user has permission
    let documentContext = "";
    if (documentBlobName && canUseDocuments(user.role)) {
      try {
        console.log(`[${user.uid}] Loading document: ${documentBlobName}`);
        documentContext = await extractTextFromBlob(documentBlobName);
        console.log(`[${user.uid}] Document loaded: ${documentContext.length} chars`);
      } catch (err) {
        console.warn(`[${user.uid}] Document load failed: ${err.message}`);
      }
    } else if (documentBlobName && !canUseDocuments(user.role)) {
      console.log(`[${user.uid}] Document requested but user role "${user.role}" cannot use documents`);
    }

    // 3. Generate answer
    const { turkishAnswer, englishAnswer } = await generateAnswer({
      question: detectedQuestion,
      specialty,
      context: context || "",
      documentContext,
    });

    // 4. Save exam session for pro/premium users
    if (sessionId && (user.role === "pro" || user.role === "premium")) {
      try {
        await saveExamSession(user.uid, sessionId, {
          specialty,
          detectedQuestion,
          turkishAnswer,
          englishAnswer,
          documentBlobName: documentBlobName || null,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        console.warn(`[${user.uid}] Session save failed: ${err.message}`);
      }
    }

    // 5. Return response
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
