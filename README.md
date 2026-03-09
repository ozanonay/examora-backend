# Examora Backend

AI-powered backend for the Examora iOS app. Uses Azure OpenAI for speech transcription and expert answer generation, Azure Blob Storage for specialty PDF documents.

## API Endpoints

### `POST /api/answer`
Multipart form data:
- `audio` (file) — WAV audio recording
- `specialty` (text) — e.g. "Tıp", "Hukuk"
- `context` (text, optional) — user notes
- `sessionId` (text) — session identifier
- `documentBlobName` (text, optional) — selected specialty PDF blob name

Response:
```json
{
  "detected_question": "...",
  "turkish_answer": "...",
  "english_answer": "..."
}
```

### `POST /api/documents`
Upload a specialty PDF:
- `file` (PDF) — max 20MB
- `specialty` (text)
- `userId` (text)

### `GET /api/documents?specialty=Tıp`
List documents, optionally filtered by specialty.

### `DELETE /api/documents/:blobName`
Delete a document.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `AZURE_OPENAI_ENDPOINT` | Azure OpenAI resource endpoint |
| `AZURE_OPENAI_API_KEY` | Azure OpenAI API key |
| `AZURE_OPENAI_API_VERSION` | API version (default: 2024-12-01-preview) |
| `AZURE_WHISPER_DEPLOYMENT` | Whisper model deployment name |
| `AZURE_GPT_DEPLOYMENT` | GPT model deployment name |
| `AZURE_STORAGE_CONNECTION_STRING` | Azure Blob Storage connection string |
| `AZURE_STORAGE_CONTAINER` | Blob container name (default: documents) |
| `API_KEY` | App authentication key |
| `PORT` | Server port (default: 3000) |

