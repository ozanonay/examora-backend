const express = require("express");
const multer = require("multer");
const { authenticateRequest } = require("../middleware/auth");
const { canUseDocuments, getRemainingSeconds, addMonthlyUsageSeconds, resolveUsageKey } = require("../services/firebase");
const { transcribeAudio, generateAnswer } = require("../services/azureOpenai");
const { extractTextFromBlob, saveExamSession } = require("../services/blobStorage");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

router.post("/answer", authenticateRequest, upload.single("audio"), async (req, res) => {
  try {
    const audioFile = req.file;
    const {
      specialty,
      context,
      documentContext: inlineDocText,   // iOS'tan gelen inline belge metni
      sessionId,
      documentBlobName,
      responseLanguage,                  // ISO 639-1 kodu — "tr", "de", "en" vb.
      recordingSeconds: recordingSecondsRaw, // kayıt süresi (iOS'tan)
    } = req.body;
    const user = req.user;
    const recordingSeconds = Math.max(0, parseInt(recordingSecondsRaw, 10) || 0);

    if (!audioFile || !audioFile.buffer || audioFile.buffer.length < 1000) {
      return res.status(400).json({ error: "Audio file is missing or too short" });
    }

    if (!specialty) {
      return res.status(400).json({ error: "Specialty field is required" });
    }

    // 0. Aylık kullanım limiti kontrolü (deviceId tabanlı — anon kullanıcılar için)
    const usageKey = resolveUsageKey(user);
    try {
      const { remaining } = await getRemainingSeconds(usageKey, user.role);
      if (remaining <= 0) {
        return res.status(429).json({
          error: "monthly_limit_exceeded",
          message: "Aylık kullanım limitinizi doldurdunuz. Bir sonraki ay yenilenir.",
        });
      }
    } catch (usageErr) {
      // Kullanım kontrolü başarısız olursa devam et — bloklamayalım
      console.warn(`[${user.uid}] Usage check failed: ${usageErr.message}`);
    }

    console.log(`[${user.uid}/${sessionId || "no-session"}] Processing: ${specialty}, audio ${(audioFile.buffer.length / 1024).toFixed(0)}KB, ${recordingSeconds}s recorded`);

    // 1. Transcribe audio
    const detectedQuestion = await transcribeAudio(audioFile.buffer);

    if (!detectedQuestion || detectedQuestion.trim().length < 3) {
      return res.status(422).json({ error: "Could not detect speech. Please speak more clearly." });
    }

    console.log(`[${user.uid}] Question: "${detectedQuestion.substring(0, 80)}..."`);

    // 2. Belge context'ini çöz: önce Azure Blob, yoksa iOS'tan gelen inline metin
    let resolvedDocumentContext = inlineDocText || "";
    if (documentBlobName && canUseDocuments(user.role)) {
      try {
        console.log(`[${user.uid}] Loading document: ${documentBlobName}`);
        resolvedDocumentContext = await extractTextFromBlob(documentBlobName);
        console.log(`[${user.uid}] Document loaded: ${resolvedDocumentContext.length} chars`);
      } catch (err) {
        console.warn(`[${user.uid}] Document load failed: ${err.message}`);
        // Blob yüklenemezse inline metin varsa ona geri dön
        resolvedDocumentContext = inlineDocText || "";
      }
    } else if (documentBlobName && !canUseDocuments(user.role)) {
      console.log(`[${user.uid}] Document requested but user role "${user.role}" cannot use documents`);
    }

    // 3. Generate answer
    const { turkishAnswer, englishAnswer } = await generateAnswer({
      question: detectedQuestion,
      specialty,
      context: context || "",
      documentContext: resolvedDocumentContext,
      responseLanguage: responseLanguage || "tr",
    });

    // 4a. Record monthly usage (deviceId tabanlı — anon kullanıcılar için)
    if (recordingSeconds > 0) {
      try {
        await addMonthlyUsageSeconds(usageKey, recordingSeconds);
        console.log(`[${user.uid}] Usage recorded: +${recordingSeconds}s (key: ${usageKey})`);
      } catch (usageErr) {
        console.warn(`[${user.uid}] Usage record failed: ${usageErr.message}`);
      }
    }

    // 4b. Save exam session for pro/premium users
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
    console.error(err.stack);

    if (err.status === 429) {
      return res.status(429).json({ error: "Rate limit exceeded. Please try again." });
    }

    // Azure OpenAI içerik filtresi — kullanıcıya anlamlı mesaj
    const isContentFilter =
      err.status === 400 ||
      (err.message && /content management policy|content filter/i.test(err.message));
    if (isContentFilter) {
      return res.status(422).json({
        error: "İçerik filtresi nedeniyle yanıt oluşturulamadı. Soruyu farklı ifade edip tekrar deneyin.",
      });
    }

    // Production'da detay gösterme; Railway loglarından bakılır
    const detail = process.env.NODE_ENV === "production" ? undefined : err.message;
    res.status(500).json({
      error: "Internal server error",
      ...(detail && { detail }),
    });
  }
});

module.exports = router;
