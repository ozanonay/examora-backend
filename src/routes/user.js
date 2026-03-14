const express = require("express");
const { authenticateRequest, authenticateUser } = require("../middleware/auth");
const { setUserRole, auth, db } = require("../services/firebase");

const router = express.Router();

// Get current user profile
router.get("/user/me", authenticateRequest, async (req, res) => {
  res.json({
    uid: req.user.uid,
    email: req.user.email,
    role: req.user.role,
  });
});

// Delete user account
// - Firebase Auth kaydı silinir
// - Firestore verileri (users/{uid} + alt koleksiyonlar) silinir
// - Azure blob'ları (dökümanlar, session kayıtları) KORUNUR — bu dosyalar şirkete aittir
// - Sadece kimliği doğrulanmış, anonim olmayan kullanıcılar bu endpoint'i kullanabilir
router.delete("/user/me", authenticateUser, async (req, res) => {
  const { uid, email } = req.user;

  // Anonim hesaplar bu endpoint'i kullanamaz
  if (!uid || !email) {
    return res.status(400).json({ error: "Anonymous accounts cannot be deleted via this endpoint" });
  }

  try {
    // 1. Firestore alt koleksiyonları sil (usage geçmişi)
    const userRef = db.collection("users").doc(uid);

    async function deleteCollection(colRef, batchSize = 100) {
      const snapshot = await colRef.limit(batchSize).get();
      if (snapshot.empty) return;
      const batch = db.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      if (snapshot.size === batchSize) await deleteCollection(colRef, batchSize);
    }

    await deleteCollection(userRef.collection("usage"));

    // 2. Ana kullanıcı dokümanını sil
    await userRef.delete();

    // 3. Firebase Auth kaydını sil
    await auth.deleteUser(uid);

    console.log(`[DeleteAccount] Kullanıcı silindi: ${uid} (${email})`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[DeleteAccount] Hata (uid=${uid}):`, err.message);
    res.status(500).json({ error: "Account deletion failed. Please try again." });
  }
});

// Admin: set user role (only premium users can do this)
router.post("/user/role", authenticateRequest, async (req, res) => {
  try {
    if (req.user.role !== "premium") {
      return res.status(403).json({ error: "Only premium users can set roles" });
    }

    const { targetUid, role } = req.body;
    if (!targetUid || !role) {
      return res.status(400).json({ error: "targetUid and role are required" });
    }

    if (!["free", "pro", "premium"].includes(role)) {
      return res.status(400).json({ error: "Invalid role. Must be: free, pro, or premium" });
    }

    await setUserRole(targetUid, role);
    res.json({ success: true, uid: targetUid, role });
  } catch (err) {
    console.error("Set role error:", err.message);
    res.status(500).json({ error: "Failed to set user role" });
  }
});

module.exports = router;
