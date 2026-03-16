const express = require("express");
const multer = require("multer");
const { authenticateRequest } = require("../middleware/auth");
const {
  canUploadDocuments,
  MONTHLY_DOC_LIMITS,
  getMonthlyDocCount,
  incrementMonthlyDocCount,
} = require("../services/firebase");
const {
  uploadDocument,
  listDocumentsForUser,
  listAllDocumentsForSpecialty,
  listSharedDocuments,
  deleteDocument,
} = require("../services/blobStorage");

const router = express.Router();

// ── Dosya boyutu limitleri ────────────────────────────────────────────────────
// 300-400 sayfalık PDF ≈ 50-80 MB; TXT genellikle çok daha küçük.
// 100 MB limiti büyük akademik dökümanları kapsar.
const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

function isAllowedFile(mimetype, originalname) {
  const ext = (originalname || "").toLowerCase().split(".").pop();
  // MIME type kontrolü
  if (mimetype === "application/pdf" || mimetype === "text/plain") return true;
  // Bazı sistemlerde .txt, application/octet-stream olarak gelebilir
  if (ext === "pdf" || ext === "txt") return true;
  return false;
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (isAllowedFile(file.mimetype, file.originalname)) {
      cb(null, true);
    } else {
      const err = new Error("Sadece PDF veya TXT dosyaları yüklenebilir");
      err.code = "UNSUPPORTED_FILE_TYPE";
      cb(err, false);
    }
  },
});

// ── GET /api/documents/quota — Aylık kalan yükleme hakkını döner ──────────────
router.get("/documents/quota", authenticateRequest, async (req, res) => {
  try {
    const { uid, role } = req.user;
    const limit = MONTHLY_DOC_LIMITS[role] ?? 0;
    const used = limit > 0 ? await getMonthlyDocCount(uid) : 0;
    res.json({ used, limit, remaining: Math.max(0, limit - used), role });
  } catch (err) {
    console.error("Quota fetch error:", err.message);
    res.status(500).json({ error: "Kota bilgisi alınamadı" });
  }
});

// ── POST /api/documents — Doküman yükle (Pro/Premium) ────────────────────────
router.post("/documents", authenticateRequest, upload.single("file"), async (req, res) => {
  try {
    const user = req.user;

    // 1. Plan kontrolü
    if (!canUploadDocuments(user.role)) {
      return res.status(403).json({
        error: "Doküman yükleme Pro veya Premium plan gerektirir",
        code: "PLAN_REQUIRED",
      });
    }

    const file = req.file;
    const { specialty, shared, topic } = req.body;

    if (!file) {
      return res.status(400).json({ error: "Dosya gereklidir (PDF veya TXT)" });
    }
    if (!specialty) {
      return res.status(400).json({ error: "Uzmanlık alanı (specialty) zorunludur" });
    }
    if (!topic || !topic.trim()) {
      return res.status(400).json({ error: "Konu (topic) zorunludur" });
    }

    // 2. Aylık upload limiti kontrolü
    const monthlyLimit = MONTHLY_DOC_LIMITS[user.role] ?? 0;
    const currentCount = await getMonthlyDocCount(user.uid);

    if (currentCount >= monthlyLimit) {
      return res.status(429).json({
        error: `Bu ay için doküman limitine ulaştınız (${currentCount}/${monthlyLimit}). Limit her ayın başında sıfırlanır.`,
        code: "MONTHLY_DOC_LIMIT_REACHED",
        used: currentCount,
        limit: monthlyLimit,
      });
    }

    const fileSizeKB = (file.size / 1024).toFixed(0);
    const ext = (file.originalname || "").toLowerCase().split(".").pop();
    console.log(
      `[${user.uid}] Upload: ${file.originalname} (${fileSizeKB} KB, .${ext}) → ${specialty} [${topic}] (${currentCount + 1}/${monthlyLimit})`
    );

    // 3. Azure'a yükle
    // iOS multipart formu "true"/"false" string gönderir; doğrudan boolean da gelebilir.
    const isShared = shared === "true" || shared === true;
    const result = await uploadDocument(
      file.buffer,
      file.originalname,
      specialty,
      user.uid,
      isShared,
      topic.trim()
    );

    // 4. Başarılıysa aylık sayacı artır
    await incrementMonthlyDocCount(user.uid);

    res.json({
      success: true,
      blob_name: result.blobName,
      url: result.url,
      original_name: file.originalname,
      file_type: ext,
      specialty,
      topic: topic.trim(),
      shared: isShared,
      monthly_usage: { used: currentCount + 1, limit: monthlyLimit },
    });
  } catch (err) {
    // Multer dosya boyutu hatası
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "Dosya çok büyük. Maksimum boyut 100 MB.",
        code: "FILE_TOO_LARGE",
      });
    }
    // Desteklenmeyen dosya tipi
    if (err.code === "UNSUPPORTED_FILE_TYPE") {
      return res.status(415).json({ error: err.message, code: "UNSUPPORTED_FILE_TYPE" });
    }
    console.error("Document upload error:", err.message);
    res.status(500).json({ error: "Doküman yüklenemedi. Lütfen tekrar deneyin." });
  }
});

// ── GET /api/documents — Doküman listesi ─────────────────────────────────────
// - Premium: o uzmanlıktaki TÜM dökümanlar
// - Pro:     kendi dökümanları + paylaşılan dökümanlar
// - Free/Anon: sadece paylaşılan dökümanlar
router.get("/documents", authenticateRequest, async (req, res) => {
  try {
    const user = req.user;
    const { specialty } = req.query;

    if (!specialty) {
      return res.status(400).json({ error: "specialty query parametresi zorunludur" });
    }

    let docs;

    if (user.role === "premium") {
      docs = await listAllDocumentsForSpecialty(specialty, user.uid);
    } else if (user.role === "pro") {
      const rawDocs = await listDocumentsForUser(user.uid, specialty);
      docs = rawDocs.map((d) => ({ ...d, isMine: d.uploadedBy === user.uid }));
    } else {
      const rawDocs = await listSharedDocuments(specialty);
      docs = rawDocs.map((d) => ({ ...d, isMine: false }));
    }

    res.json({
      count: docs.length,
      documents: docs.map((d) => ({
        blob_name: d.blobName,
        original_name: d.originalName,
        file_type: d.fileType || "pdf",
        specialty: d.specialty,
        topic: d.topic || "",
        uploaded_by: d.uploadedBy,
        uploaded_at: d.uploadedAt,
        shared: d.shared ?? false,
        page_count: d.pageCount,
        size: d.size,
        is_mine: d.isMine ?? (d.uploadedBy === user.uid),
      })),
    });
  } catch (err) {
    console.error("Document list error:", err.message);
    res.status(500).json({ error: "Doküman listesi alınamadı" });
  }
});

// ── GET /api/documents/shared — Paylaşılan dökümanlar ────────────────────────
router.get("/documents/shared", authenticateRequest, async (req, res) => {
  try {
    const { specialty } = req.query;
    const docs = await listSharedDocuments(specialty || undefined);

    res.json({
      count: docs.length,
      documents: docs.map((d) => ({
        blob_name: d.blobName,
        original_name: d.originalName,
        file_type: d.fileType || "pdf",
        specialty: d.specialty,
        uploaded_by: d.uploadedBy,
        uploaded_at: d.uploadedAt,
        page_count: d.pageCount,
        size: d.size,
      })),
    });
  } catch (err) {
    console.error("Shared document list error:", err.message);
    res.status(500).json({ error: "Paylaşılan dökümanlar alınamadı" });
  }
});

// ── DELETE /api/documents — Döküman sil (sadece sahip) ───────────────────────
router.delete("/documents", authenticateRequest, async (req, res) => {
  try {
    const { blobName } = req.body;
    const user = req.user;

    if (!blobName) {
      return res.status(400).json({ error: "blobName zorunludur" });
    }

    // SECURITY: Reject path traversal attempts
    if (blobName.includes("..") || blobName.includes("%2e") || blobName.includes("%2E")) {
      console.warn(`[Security] Path traversal attempt by uid=${user.uid}: ${blobName}`);
      return res.status(400).json({ error: "Geçersiz dosya yolu" });
    }

    // SECURITY: Verify ownership via blob metadata (NOT path string matching).
    // This prevents IDOR attacks where an attacker crafts a blobName that
    // includes their UID while pointing to someone else's file.
    const { getDocumentMetadata } = require("../services/blobStorage");
    const metadata = await getDocumentMetadata(blobName);

    if (!metadata) {
      return res.status(404).json({ error: "Döküman bulunamadı" });
    }

    // Only the original uploader can delete their documents
    if (metadata.uploadedby !== user.uid) {
      console.warn(`[Security] Unauthorized delete attempt: uid=${user.uid} tried to delete blob owned by ${metadata.uploadedby}`);
      return res.status(403).json({ error: "Yalnızca kendi dökümanlarınızı silebilirsiniz" });
    }

    await deleteDocument(blobName);
    res.json({ success: true });
  } catch (err) {
    console.error("Document delete error:", err.message);
    res.status(500).json({ error: "Döküman silinemedi" });
  }
});

module.exports = router;
