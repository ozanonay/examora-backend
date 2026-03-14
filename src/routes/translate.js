const express = require("express");
const { authenticateRequest } = require("../middleware/auth");
const { translateToTurkish, translateToTargetLanguage } = require("../services/azureOpenai");

const router = express.Router();

/**
 * POST /api/translate
 * Body: { text: string } — İngilizce metin
 * Returns: { translated: string } — Türkçe çeviri (canlı transkript için, hızlı)
 */
router.post("/translate", authenticateRequest, async (req, res) => {
  try {
    const { text } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'text' in body" });
    }
    const translated = await translateToTurkish(text);
    res.json({ translated });
  } catch (err) {
    console.error("Translate endpoint error:", err.message);
    res.status(500).json({ error: "Translation failed", detail: err.message });
  }
});

/**
 * POST /api/translate-localization
 * Body: { text: string, targetLang: "en"|"de"|"fr" }
 * Header: X-Localization-Key: <LOCALIZATION_API_KEY>
 * Returns: { translated: string } — TR → hedef dil çeviri (script için)
 */
router.post("/translate-localization", async (req, res) => {
  const key = process.env.LOCALIZATION_API_KEY;
  if (key) {
    const provided = req.headers["x-localization-key"];
    if (provided !== key) {
      return res.status(401).json({ error: "Invalid or missing X-Localization-Key" });
    }
  }
  try {
    const { text, targetLang } = req.body || {};
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "Missing or invalid 'text' in body" });
    }
    const lang = String(targetLang || "en").toLowerCase();
    if (!["en", "de", "fr"].includes(lang)) {
      return res.status(400).json({ error: "targetLang must be en, de, or fr" });
    }
    const translated = await translateToTargetLanguage(text, lang);
    res.json({ translated });
  } catch (err) {
    console.error("Translate-localization error:", err.message);
    res.status(500).json({ error: "Translation failed", detail: err.message });
  }
});

module.exports = router;
