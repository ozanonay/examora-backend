const { AzureOpenAI } = require("openai");
const fs = require("fs");
const path = require("path");

// Main Azure OpenAI client (GPT, etc.)
const client = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview",
});

// Optional dedicated Whisper client (when AZURE_WHISPER_* are set)
const whisperEndpoint = process.env.AZURE_WHISPER_ENDPOINT;
const whisperApiKey = process.env.AZURE_WHISPER_API_KEY;
let whisperClient = null;
if (whisperEndpoint && whisperApiKey) {
  try {
    const baseUrl = new URL(whisperEndpoint).origin;
    const apiVersion = new URL(whisperEndpoint).searchParams.get("api-version") || "2024-06-01";
    whisperClient = new AzureOpenAI({
      endpoint: baseUrl,
      apiKey: whisperApiKey,
      apiVersion,
    });
  } catch (e) {
    console.warn("AZURE_WHISPER_ENDPOINT invalid, using main client for Whisper:", e.message);
  }
}

const WHISPER_DEPLOYMENT = process.env.AZURE_WHISPER_DEPLOYMENT || "whisper";
const GPT_DEPLOYMENT = process.env.AZURE_GPT_DEPLOYMENT || "gpt-4o";

/**
 * Transcribe audio via Azure OpenAI Whisper
 * Uses AZURE_WHISPER_* when set, otherwise AZURE_OPENAI_*.
 * @param {Buffer} audioBuffer - Raw audio bytes
 * @param {string} [ext] - File extension (e.g. "mp3", "wav"). Default "wav".
 */
async function transcribeAudio(audioBuffer, ext = "wav") {
  const safeExt = ext && ext.replace(/[^a-z0-9]/gi, "") ? `.${ext.replace(/[^a-z0-9]/gi, "").toLowerCase()}` : ".wav";
  const tmpPath = path.join("/tmp", `examora-${Date.now()}${safeExt}`);
  fs.writeFileSync(tmpPath, audioBuffer);

  const transcriptionClient = whisperClient || client;

  try {
    const response = await transcriptionClient.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: WHISPER_DEPLOYMENT,
      response_format: "text",
    });
    const text = typeof response === "string" ? response : (response && response.text) || "";
    return text;
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

// ISO 639-1 → full language name mapping
const LANGUAGE_NAMES = {
  tr: "Turkish",
  en: "English",
  de: "German",
  fr: "French",
  es: "Spanish",
  ar: "Arabic",
  ru: "Russian",
  zh: "Chinese",
  ja: "Japanese",
  it: "Italian",
};

/**
 * Generate expert answer via Azure OpenAI GPT
 * @param {object} params
 * @param {string} params.question
 * @param {string} params.specialty
 * @param {string} params.context        - user manual notes
 * @param {string} [params.documentContext] - extracted reference document text
 * @param {string} [params.responseLanguage] - ISO 639-1 code, e.g. "tr", "de"
 */
async function generateAnswer({ question, specialty, context, documentContext, responseLanguage = "tr" }) {
  const systemPrompt = buildSystemPrompt(specialty, context, documentContext, responseLanguage);

  const response = await client.chat.completions.create({
    model: GPT_DEPLOYMENT,
    temperature: 0.4,
    max_tokens: 2000,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    response_format: { type: "json_object" },
  });

  const raw = response.choices[0]?.message?.content || "{}";

  try {
    const parsed = JSON.parse(raw);
    return {
      turkishAnswer: parsed.turkish_answer || "",
      englishAnswer: parsed.english_answer || "",
    };
  } catch {
    return { turkishAnswer: raw, englishAnswer: "" };
  }
}

function buildSystemPrompt(specialty, context, documentContext, responseLanguage = "tr") {
  const primaryLang = LANGUAGE_NAMES[responseLanguage] || responseLanguage.toUpperCase();

  // Dil yönergesi: seçilen dil İngilizce ise tekrar etme
  const langInstruction =
    primaryLang === "English"
      ? `Answer in English.`
      : `Answer in BOTH ${primaryLang} AND English.`;

  // JSON alanlarının ne içereceğini açıkla
  const formatNote =
    primaryLang === "English"
      ? `  "turkish_answer": "...",  // Answer in English\n  "english_answer": "..."   // Answer in English (same language)`
      : `  "turkish_answer": "...",  // Answer in ${primaryLang}\n  "english_answer": "..."   // Answer in English`;

  let prompt = `You are Examora, an AI assistant specialized in "${specialty}".
Your job is to provide the most accurate, concise, and professionally appropriate answer to the user's question.

RULES:
- Follow globally accepted procedures and guidelines for the "${specialty}" field.
- Be precise, evidence-based, and professional.
- If reference documents are provided, prioritize information from those documents while supplementing with your general knowledge.
- If user notes/context are provided, incorporate them as well.
- ${langInstruction}

OUTPUT FORMAT (strict JSON):
{
${formatNote}
}

Provide only the JSON object, no markdown, no extra text.`;

  if (documentContext && documentContext.trim()) {
    // Belge içeriği 12.000 karakterde kes — token limitini koru
    const truncated = documentContext.substring(0, 12000);
    prompt += `\n\nREFERENCE DOCUMENT (specialty knowledge base):\n${truncated}`;
  }

  if (context && context.trim()) {
    // Manuel notlar 3.000 karakterde kes
    const truncatedContext = context.substring(0, 3000);
    prompt += `\n\nADDITIONAL USER NOTES:\n${truncatedContext}`;
  }

  return prompt;
}

module.exports = { transcribeAudio, generateAnswer };
