const { BlobServiceClient } = require("@azure/storage-blob");
const pdfParse = require("pdf-parse");

const connectionString = process.env.AZURE_STORAGE_CONNECTION_STRING;
const containerName = process.env.AZURE_STORAGE_CONTAINER || "documents";

let containerClient = null;

function getContainerClient() {
  if (!containerClient) {
    const blobService = BlobServiceClient.fromConnectionString(connectionString);
    containerClient = blobService.getContainerClient(containerName);
  }
  return containerClient;
}

/**
 * Ensure the blob container exists
 */
async function ensureContainer() {
  const client = getContainerClient();
  await client.createIfNotExists({ access: "blob" });
}

/**
 * Upload a PDF to Azure Blob Storage
 * @param {Buffer} fileBuffer
 * @param {string} originalName
 * @param {string} specialty - specialty tag for organization
 * @param {string} uploadedBy - user ID
 * @returns {Promise<{blobName: string, url: string}>}
 */
async function uploadDocument(fileBuffer, originalName, specialty, uploadedBy) {
  await ensureContainer();
  const client = getContainerClient();

  const sanitized = originalName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const blobName = `${specialty}/${Date.now()}-${sanitized}`;
  const blockBlob = client.getBlockBlobClient(blobName);

  await blockBlob.upload(fileBuffer, fileBuffer.length, {
    blobHTTPHeaders: { blobContentType: "application/pdf" },
    metadata: {
      specialty,
      uploadedby: uploadedBy,
      originalname: originalName,
      uploadedat: new Date().toISOString(),
    },
  });

  return { blobName, url: blockBlob.url };
}

/**
 * List documents, optionally filtered by specialty
 * @param {string} [specialty]
 * @returns {Promise<Array<{name, specialty, uploadedBy, originalName, uploadedAt, url}>>}
 */
async function listDocuments(specialty) {
  await ensureContainer();
  const client = getContainerClient();

  const prefix = specialty ? `${specialty}/` : undefined;
  const docs = [];

  for await (const blob of client.listBlobsFlat({ prefix, includeMetadata: true })) {
    const meta = blob.metadata || {};
    docs.push({
      name: blob.name,
      specialty: meta.specialty || "unknown",
      uploadedBy: meta.uploadedby || "unknown",
      originalName: meta.originalname || blob.name,
      uploadedAt: meta.uploadedat || "",
      url: `${client.url}/${blob.name}`,
      size: blob.properties.contentLength,
    });
  }

  return docs;
}

/**
 * Download a blob and extract text from PDF
 * @param {string} blobName
 * @returns {Promise<string>} - extracted text
 */
async function extractTextFromBlob(blobName) {
  const client = getContainerClient();
  const blockBlob = client.getBlockBlobClient(blobName);

  const downloadResponse = await blockBlob.download(0);
  const chunks = [];
  for await (const chunk of downloadResponse.readableStreamBody) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);

  const pdfData = await pdfParse(buffer);
  return pdfData.text || "";
}

/**
 * Delete a document
 * @param {string} blobName
 */
async function deleteDocument(blobName) {
  const client = getContainerClient();
  const blockBlob = client.getBlockBlobClient(blobName);
  await blockBlob.deleteIfExists();
}

module.exports = {
  ensureContainer,
  uploadDocument,
  listDocuments,
  extractTextFromBlob,
  deleteDocument,
};
