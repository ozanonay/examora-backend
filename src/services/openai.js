const OpenAI = require("openai");
const fs = require("fs");
const path = require("path");

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Transcribe audio using Whisper
 * @param {Buffer} audioBuffer - WAV audio data
 * @returns {Promise<string>} - Transcribed text
 */
async function transcribeAudio(audioBuffer) {
  const tmpPath = path.join("/tmp", `examora-${Date.now()}.wav`);
  fs.writeFileSync(tmpPath, audioBuffer);

  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: "whisper-1",
      language: "en",
    });
    return response.text || "";
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

/**
 * Generate expert answer based on specialty, context and detected question
 * @param {object} params
 * @returns {Promise<{turkishAnswer: string, englishAnswer: string}>}
 */
async function generateAnswer({ question, specialty, context }) {
  const systemPrompt = buildSystemPrompt(specialty, context);

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
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

function buildSystemPrompt(specialty, context) {
  let prompt = `You are Examora, an AI assistant specialized in "${specialty}".
Your job is to provide the most accurate, concise, and professionally appropriate answer to the user's question.

RULES:
- Follow globally accepted procedures and guidelines for the "${specialty}" field.
- Be precise, evidence-based, and professional.
- If context/notes are provided, incorporate them into your answer.
- Answer in BOTH Turkish and English.

OUTPUT FORMAT (strict JSON):
{
  "turkish_answer": "...",
  "english_answer": "..."
}

Provide only the JSON object, no markdown, no extra text.`;

  if (context && context.trim()) {
    prompt += `\n\nADDITIONAL CONTEXT FROM USER:\n${context}`;
  }

  return prompt;
}

module.exports = { transcribeAudio, generateAnswer };
