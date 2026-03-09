const { BlobServiceClient } = require("@azure/storage-blob");
const pdfParse = require("pdf-parse");

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const DOCS_CONTAINER = process.env.AZURE_STORAGE_CONTAINER || "documents";
const SESSIONS_CONTAINER = "sessions";

let blobService = null;

function getBlobService() {
  if (!blobService) {
    blobService = BlobServiceClient.fromConnectionString(connectionString);
  }
  return blobService;
}

async function ensureContainer(name) {
  const client = getBlobService().getContainerClient(name);
  await client.createIfNotExists();
  return client;
}

// ═══════════════════════════════════════
// DOCUMENTS (PDF uploads by users)
// ═══════════════════════════════════════
// Blob path: {specialty}/{userId}/{timestamp}-{filename}.pdf
// Shared docs: {specialty}/shared/{timestamp}-{filename}.pdf

/**
 * Upload a PDF document
 */
async function uploadDocument(fileBuffer, originalName, specialty, userId, isShared = false) {
  const container = await ensureContainer(DOCS_CONTAINER);

  const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const folder = isShared ? `${specialty}/shared` : `${specialty}/${userId}`;
  const blobName = `${folder}/${Date.now()}-${sanitized}`;
  const blockBlob = container.getBlockBlobClient(blobName);

  await blockBlob.upload(fileBuffer, fileBuffer.length, {
    blobHTTPHeaders: { blobContentType: "application/pdf" },
    metadata: {
      specialty,
      uploadedby: userId,
      originalname: originalName,
      uploadedat: new Date().toISOString(),
      shared: isShared ? "true" : "false",
      pagecount: "0",
    },
  });

  // Extract text and store page count in metadata
  try {
    const pdfData = await pdfParse(fileBuffer);
    const pageCount = pdfData.numpages || 0;
    await blockBlob.setMetadata({
      specialty,
      uploadedby: userId,
      originalname: originalName,
      uploadedat: new Date().toISOString(),
      shared: isShared ? "true" : "false",
      pagecount: String(pageCount),
      textlength: String(pdfData.text?.length || 0),
    });
  } catch (_) {
    // PDF parse failed — metadata stays with pagecount=0
  }

  return { blobName, url: blockBlob.url };
}

/**
 * List documents accessible to a user for a given specialty
 * Returns: user's own docs + shared docs for that specialty
 */
async function listDocumentsForUser(userId, specialty) {
  const container = await ensureContainer(DOCS_CONTAINER);
  const docs = [];

  // User's own documents
  const userPrefix = specialty ? `${specialty}/${userId}/` : null;
  // Shared documents
  const sharedPrefix = specialty ? `${specialty}/shared/` : null;

  const prefixes = [userPrefix, sharedPrefix].filter(Boolean);

  for (const prefix of prefixes) {
    for await (const blob of container.listBlobsFlat({ prefix, includeMetadata: true })) {
      const meta = blob.metadata || {};
      docs.push({
        blobName: blob.name,
        originalName: meta.originalname || blob.name.split("/").pop(),
        specialty: meta.specialty || "unknown",
        uploadedBy: meta.uploadedby || "unknown",
        uploadedAt: meta.uploadedat || "",
        shared: meta.shared === "true",
        pageCount: parseInt(meta.pagecount || "0", 10),
        size: blob.properties.contentLength,
      });
    }
  }

  return docs;
}

/**
 * List all documents (admin or for "Sistemdeki özel veriler")
 */
async function listSharedDocuments(specialty) {
  const container = await ensureContainer(DOCS_CONTAINER);
  const docs = [];

  const prefix = specialty ? `${specialty}/shared/` : undefined;

  for await (const blob of container.listBlobsFlat({ prefix, includeMetadata: true })) {
    const meta = blob.metadata || {};
    if (meta.shared !== "true" && prefix) continue;
    docs.push({
      blobName: blob.name,
      originalName: meta.originalname || blob.name.split("/").pop(),
      specialty: meta.specialty || "unknown",
      uploadedBy: meta.uploadedby || "unknown",
      uploadedAt: meta.uploadedat || "",
      pageCount: parseInt(meta.pagecount || "0", 10),
      size: blob.properties.contentLength,
    });
  }

  return docs;
}

/**
 * List ALL documents under a specialty prefix (Premium users only).
 * Returns every user's uploads + shared docs for that specialty.
 * @param {string} specialty - e.g. "Medicine"
 * @param {string} requestingUserId - used to set is_mine flag
 */
async function listAllDocumentsForSpecialty(specialty, requestingUserId) {
  const container = await ensureContainer(DOCS_CONTAINER);
  const docs = [];

  // List everything under {specialty}/
  const prefix = `${specialty}/`;

  for await (const blob of container.listBlobsFlat({ prefix, includeMetadata: true })) {
    const meta = blob.metadata || {};
    docs.push({
      blobName: blob.name,
      originalName: meta.originalname || blob.name.split("/").pop(),
      specialty: meta.specialty || specialty,
      uploadedBy: meta.uploadedby || "unknown",
      uploadedAt: meta.uploadedat || "",
      shared: meta.shared === "true",
      pageCount: parseInt(meta.pagecount || "0", 10),
      size: blob.properties.contentLength,
      isMine: meta.uploadedby === requestingUserId,
    });
  }

  return docs;
}

/**
 * Extract text from a PDF blob for LLM consumption
 * Handles large PDFs by truncating to token-safe length
 */
async function extractTextFromBlob(blobName) {
  const container = await ensureContainer(DOCS_CONTAINER);
  const blockBlob = container.getBlockBlobClient(blobName);

  const downloadResponse = await blockBlob.download(0);
  const chunks = [];
  for await (const chunk of downloadResponse.readableStreamBody) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  const pdfData = await pdfParse(buffer);
  const fullText = pdfData.text || "";

  // Truncate to ~15000 chars (~4000 tokens) for LLM context window safety
  const MAX_CHARS = 15000;
  if (fullText.length <= MAX_CHARS) return fullText;

  return fullText.substring(0, MAX_CHARS) + `\n\n[... doküman ${MAX_CHARS} karakterde kesildi, toplam ${fullText.length} karakter]`;
}

/**
 * Delete a document (only owner or admin)
 */
async function deleteDocument(blobName) {
  const container = await ensureContainer(DOCS_CONTAINER);
  const blockBlob = container.getBlockBlobClient(blobName);
  await blockBlob.deleteIfExists();
}

// ═══════════════════════════════════════
// EXAM SESSIONS (stored per user)
// ═══════════════════════════════════════
// Blob path: {userId}/{sessionId}.json

/**
 * Save exam session data
 */
async function saveExamSession(userId, sessionId, sessionData) {
  const container = await ensureContainer(SESSIONS_CONTAINER);
  const blobName = `${userId}/${sessionId}.json`;
  const blockBlob = container.getBlockBlobClient(blobName);

  const jsonData = JSON.stringify({
    ...sessionData,
    userId,
    sessionId,
    savedAt: new Date().toISOString(),
  });

  await blockBlob.upload(jsonData, Buffer.byteLength(jsonData), {
    blobHTTPHeaders: { blobContentType: "application/json" },
    metadata: {
      userid: userId,
      sessionid: sessionId,
      specialty: sessionData.specialty || "",
      savedat: new Date().toISOString(),
    },
  });
}

/**
 * List exam sessions for a user
 */
async function listExamSessions(userId) {
  const container = await ensureContainer(SESSIONS_CONTAINER);
  const sessions = [];
  const prefix = `${userId}/`;

  for await (const blob of container.listBlobsFlat({ prefix, includeMetadata: true })) {
    const meta = blob.metadata || {};
    sessions.push({
      sessionId: meta.sessionid || blob.name.replace(prefix, "").replace(".json", ""),
      specialty: meta.specialty || "",
      savedAt: meta.savedat || "",
      size: blob.properties.contentLength,
    });
  }

  return sessions.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

/**
 * Get exam session data
 */
async function getExamSession(userId, sessionId) {
  const container = await ensureContainer(SESSIONS_CONTAINER);
  const blobName = `${userId}/${sessionId}.json`;
  const blockBlob = container.getBlockBlobClient(blobName);

  try {
    const downloadResponse = await blockBlob.download(0);
    const chunks = [];
    for await (const chunk of downloadResponse.readableStreamBody) {
      chunks.push(chunk);
    }
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch (_) {
    return null;
  }
}

module.exports = {
  uploadDocument,
  listDocumentsForUser,
  listSharedDocuments,
  listAllDocumentsForSpecialty,
  extractTextFromBlob,
  deleteDocument,
  saveExamSession,
  listExamSessions,
  getExamSession,
};
