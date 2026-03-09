const express = require("express");
const multer = require("multer");
const { validateApiKey } = require("../middleware/auth");
const { uploadDocument, listDocuments, deleteDocument } = require("../services/blobStorage");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"), false);
    }
  },
});

// Upload a document
router.post("/documents", validateApiKey, upload.single("file"), async (req, res) => {
  try {
    const file = req.file;
    const { specialty, userId } = req.body;

    if (!file) {
      return res.status(400).json({ error: "PDF file is required" });
    }
    if (!specialty) {
      return res.status(400).json({ error: "Specialty field is required" });
    }

    console.log(`[upload] ${file.originalname} (${(file.size / 1024).toFixed(0)}KB) → ${specialty}`);

    const result = await uploadDocument(
      file.buffer,
      file.originalname,
      specialty,
      userId || "anonymous"
    );

    res.json({
      success: true,
      blob_name: result.blobName,
      url: result.url,
      original_name: file.originalname,
      specialty,
    });
  } catch (err) {
    console.error("Document upload error:", err.message);
    res.status(500).json({ error: "Failed to upload document" });
  }
});

// List documents (optionally by specialty)
router.get("/documents", validateApiKey, async (req, res) => {
  try {
    const { specialty } = req.query;
    const docs = await listDocuments(specialty || undefined);

    res.json({
      count: docs.length,
      documents: docs.map((d) => ({
        blob_name: d.name,
        original_name: d.originalName,
        specialty: d.specialty,
        uploaded_by: d.uploadedBy,
        uploaded_at: d.uploadedAt,
        size: d.size,
        url: d.url,
      })),
    });
  } catch (err) {
    console.error("Document list error:", err.message);
    res.status(500).json({ error: "Failed to list documents" });
  }
});

// Delete a document (blob name sent in body since it contains slashes)
router.delete("/documents", validateApiKey, async (req, res) => {
  try {
    const { blobName } = req.body;
    if (!blobName) {
      return res.status(400).json({ error: "blobName is required" });
    }
    await deleteDocument(blobName);
    res.json({ success: true });
  } catch (err) {
    console.error("Document delete error:", err.message);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

module.exports = router;
