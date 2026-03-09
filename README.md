# Examora Backend

AI-powered backend for the Examora iOS app. Handles speech transcription, expert answer generation, and bilingual response delivery.

## API

### `POST /api/answer`

Multipart form data:
- `audio` (file) — WAV audio recording
- `specialty` (text) — e.g. "Tıp", "Hukuk"
- `context` (text, optional) — additional notes/context
- `sessionId` (text) — session identifier

Headers:
- `X-API-Key` — API authentication key

Response:
```json
{
  "detected_question": "What are the symptoms of...",
  "turkish_answer": "...",
  "english_answer": "..."
}
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key (Whisper + GPT-4o) |
| `API_KEY` | App authentication key |
| `PORT` | Server port (default: 3000) |

## Deploy on Railway

1. Connect this repo to Railway
2. Set environment variables in Railway dashboard
3. Deploy
