const express = require("express");
const multer = require("multer");
const { authenticateRequest } = require("../middleware/auth");
const { canUploadDocuments } = require("../services/firebase");
const {
  uploadDocument,
  listDocumentsForUser,
  listSharedDocuments,
  deleteDocument,
} = require("../services/blobStorage");

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === "application/pdf") {
      cb(null, true);
    } else {
      cb(new Error("Only PDF files are allowed"), false);
    }
  },
});

// Upload a document (pro/premium only)
router.post("/documents", authenticateRequest, upload.single("file"), async (req, res) => {
  try {
    const user = req.user;

    if (!canUploadDocuments(user.role)) {
      return res.status(403).json({ error: "Document upload requires Pro or Premium plan" });
    }

    const file = req.file;
    const { specialty, shared } = req.body;

    if (!file) {
      return res.status(400).json({ error: "PDF file is required" });
    }
    if (!specialty) {
      return res.status(400).json({ error: "Specialty field is required" });
    }

    console.log(`[${user.uid}] Upload: ${file.originalname} (${(file.size / 1024).toFixed(0)}KB) → ${specialty}`);

    const isShared = shared === "true";
    const result = await uploadDocument(file.buffer, file.originalname, specialty, user.uid, isShared);

    res.json({
      success: true,
      blob_name: result.blobName,
      url: result.url,
      original_name: file.originalname,
      specialty,
      shared: isShared,
    });
  } catch (err) {
    console.error("Document upload error:", err.message);
    res.status(500).json({ error: "Failed to upload document" });
  }
});

// List documents for current user (own + shared) by specialty
router.get("/documents", authenticateRequest, async (req, res) => {
  try {
    const user = req.user;
    const { specialty } = req.query;

    if (!specialty) {
      return res.status(400).json({ error: "specialty query parameter is required" });
    }

    const docs = await listDocumentsForUser(user.uid, specialty);

    res.json({
      count: docs.length,
      documents: docs.map((d) => ({
        blob_name: d.blobName,
        original_name: d.originalName,
        specialty: d.specialty,
        uploaded_by: d.uploadedBy,
        uploaded_at: d.uploadedAt,
        shared: d.shared,
        page_count: d.pageCount,
        size: d.size,
        is_mine: d.uploadedBy === user.uid,
      })),
    });
  } catch (err) {
    console.error("Document list error:", err.message);
    res.status(500).json({ error: "Failed to list documents" });
  }
});

// List shared/community documents
router.get("/documents/shared", authenticateRequest, async (req, res) => {
  try {
    const { specialty } = req.query;
    const docs = await listSharedDocuments(specialty || undefined);

    res.json({
      count: docs.length,
      documents: docs.map((d) => ({
        blob_name: d.blobName,
        original_name: d.originalName,
        specialty: d.specialty,
        uploaded_by: d.uploadedBy,
        uploaded_at: d.uploadedAt,
        page_count: d.pageCount,
        size: d.size,
      })),
    });
  } catch (err) {
    console.error("Shared document list error:", err.message);
    res.status(500).json({ error: "Failed to list shared documents" });
  }
});

// Delete a document (owner only)
router.delete("/documents", authenticateRequest, async (req, res) => {
  try {
    const { blobName } = req.body;
    const user = req.user;

    if (!blobName) {
      return res.status(400).json({ error: "blobName is required" });
    }

    // Verify ownership: blob path contains userId
    if (!blobName.includes(`/${user.uid}/`) && user.role !== "premium") {
      return res.status(403).json({ error: "You can only delete your own documents" });
    }

    await deleteDocument(blobName);
    res.json({ success: true });
  } catch (err) {
    console.error("Document delete error:", err.message);
    res.status(500).json({ error: "Failed to delete document" });
  }
});

module.exports = router;
