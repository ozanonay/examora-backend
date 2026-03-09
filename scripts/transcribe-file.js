#!/usr/bin/env node
/**
 * STT: Transcribe an audio file (mp3, wav, m4a, etc.) using Azure OpenAI Whisper.
 *
 * Usage:
 *   node scripts/transcribe-file.js "/path/to/audio.mp3"
 *
 * Requires .env in examora-backend with either:
 *   AZURE_WHISPER_ENDPOINT + AZURE_WHISPER_API_KEY  (preferred)
 *   or AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_API_KEY
 *   (optional) AZURE_WHISPER_DEPLOYMENT
 *
 * Copy from Railway → examora-backend → Variables.
 */

const path = require("path");
const fs = require("fs");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { AzureOpenAI } = require("openai");

const whisperEndpoint = process.env.AZURE_WHISPER_ENDPOINT;
const whisperApiKey = process.env.AZURE_WHISPER_API_KEY;
let client;
if (whisperEndpoint && whisperApiKey) {
  const baseUrl = new URL(whisperEndpoint).origin;
  const apiVersion = new URL(whisperEndpoint).searchParams.get("api-version") || "2024-06-01";
  client = new AzureOpenAI({ endpoint: baseUrl, apiKey: whisperApiKey, apiVersion });
} else {
  client = new AzureOpenAI({
    endpoint: process.env.AZURE_OPENAI_ENDPOINT,
    apiKey: process.env.AZURE_OPENAI_API_KEY,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-12-01-preview",
  });
}

const WHISPER_DEPLOYMENT = process.env.AZURE_WHISPER_DEPLOYMENT || "whisper";

async function transcribeFile(filePath) {
  const ext = path.extname(filePath).toLowerCase() || ".mp3";
  const tmpPath = path.join("/tmp", `stt-${Date.now()}${ext}`);
  fs.copyFileSync(filePath, tmpPath);

  try {
    const response = await client.audio.transcriptions.create({
      file: fs.createReadStream(tmpPath),
      model: WHISPER_DEPLOYMENT,
      response_format: "text",
    });
    return typeof response === "string" ? response : (response.text || "");
  } finally {
    fs.unlinkSync(tmpPath);
  }
}

const inputPath = process.argv[2];
if (!inputPath || !fs.existsSync(inputPath)) {
  console.error("Usage: node scripts/transcribe-file.js \"/path/to/audio.mp3\"");
  process.exit(1);
}

transcribeFile(inputPath)
  .then((text) => {
    console.log(text);
  })
  .catch((err) => {
    console.error("Transcription failed:", err.message);
    process.exit(1);
  });
