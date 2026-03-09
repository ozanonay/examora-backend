const { AzureOpenAI } = require("openai");
const fs = require("fs");
const path = require("path");

const client = new AzureOpenAI({
  endpoint: process.env.AZURE_OPENAI_ENDPOINT,
  apiKey: process.env.AZURE_OPENAI_API_KEY,
  apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview",
});

const WHISPER_DEPLOYMENT = process.env.AZURE_WHISPER_DEPLOYMENT || "whisper";
const GPT_DEPLOYMENT = process.env.AZURE_GPT_DEPLOYMENT || "gpt-4o";

/**
 * Transcribe audio via Azure OpenAI Whisper
 */
async function transcribeAudio(audioBuffer) {
  const tmpPath = path.join("/tmp", `examora-${Date.now()}.wav`);
  fs.writeFileSync(tmpPath, audioBuffer);

  try {
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: WHISPER_DEPLOYMENT,
      language: "en",
    });
    return response.text || "";
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

/**
 * Generate expert answer via Azure OpenAI GPT
 * @param {object} params
 * @param {string} params.question
 * @param {string} params.specialty
 * @param {string} params.context - user manual context
 * @param {string} [params.documentContext] - extracted PDF text
 */
async function generateAnswer({ question, specialty, context, documentContext }) {
  const systemPrompt = buildSystemPrompt(specialty, context, documentContext);

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

function buildSystemPrompt(specialty, context, documentContext) {
  let prompt = `You are Examora, an AI assistant specialized in "${specialty}".
Your job is to provide the most accurate, concise, and professionally appropriate answer to the user's question.

RULES:
- Follow globally accepted procedures and guidelines for the "${specialty}" field.
- Be precise, evidence-based, and professional.
- If reference documents are provided, prioritize information from those documents while supplementing with your general knowledge.
- If user notes/context are provided, incorporate them as well.
- Answer in BOTH Turkish and English.

OUTPUT FORMAT (strict JSON):
{
  "turkish_answer": "...",
  "english_answer": "..."
}

Provide only the JSON object, no markdown, no extra text.`;

  if (documentContext && documentContext.trim()) {
    const truncated = documentContext.substring(0, 12000);
    prompt += `\n\nREFERENCE DOCUMENT (specialty knowledge base):\n${truncated}`;
  }

  if (context && context.trim()) {
    prompt += `\n\nADDITIONAL USER NOTES:\n${context}`;
  }

  return prompt;
}

module.exports = { transcribeAudio, generateAnswer };
