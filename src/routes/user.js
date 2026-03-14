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

// Sync / upsert user document in Firestore.
// iOS calls this after every successful login or registration so that
// the users/{uid} document always exists and is up-to-date.
// Body (all optional): { displayName, provider }
router.post("/user/sync", authenticateUser, async (req, res) => {
  const { uid, email, role } = req.user;
  const { displayName, provider } = req.body || {};

  try {
    const userRef = db.collection("users").doc(uid);
    const now = new Date();

    // merge: true → only supplied fields overwrite; missing fields are untouched.
    await userRef.set(
      {
        uid,
        email: email || "",
        displayName: displayName || "",
        provider: provider || "unknown",
        role,
        lastSeenAt: now,
        // createdAt is written only on first call (merge won't overwrite it
        // if it already exists — handled by set+merge semantics for
        // server-supplied timestamps we DON'T want to stomp).
      },
      { merge: true }
    );

    // Write createdAt only if the document didn't exist before.
    const snap = await userRef.get();
    if (!snap.data()?.createdAt) {
      await userRef.update({ createdAt: now });
    }

    console.log(`[UserSync] Firestore user doc upserted: ${uid} (${email})`);
    res.json({ success: true });
  } catch (err) {
    console.error(`[UserSync] Error (uid=${uid}):`, err.message);
    res.status(500).json({ error: "Failed to sync user document." });
  }
});

// Delete user account (Firestore only — Firebase Auth iOS client tarafından silinir)
// - Firestore verileri (users/{uid} + tüm alt koleksiyonlar) silinir
// - Azure blob'ları (dökümanlar, session kayıtları) KORUNUR
// - Firebase Auth silme işlemi iOS tarafında yapılır (re-auth sonrası user.delete())
// - Sadece kimliği doğrulanmış, anonim olmayan kullanıcılar bu endpoint'i kullanabilir
router.delete("/user/me", authenticateUser, async (req, res) => {
  const { uid, email } = req.user;

  if (!uid || !email) {
    return res.status(400).json({ error: "Anonymous accounts cannot be deleted via this endpoint" });
  }

  try {
    const userRef = db.collection("users").doc(uid);

    // Alt koleksiyonları recursive sil
    async function deleteCollection(colRef, batchSize = 100) {
      const snapshot = await colRef.limit(batchSize).get();
      if (snapshot.empty) return;
      const batch = db.batch();
      snapshot.docs.forEach((doc) => batch.delete(doc.ref));
      await batch.commit();
      if (snapshot.size === batchSize) await deleteCollection(colRef, batchSize);
    }

    await deleteCollection(userRef.collection("usage"));
    await deleteCollection(userRef.collection("docUploads"));
    await userRef.delete();

    // NOT: Firebase Auth kaydı iOS tarafından silinir.
    // Backend burada auth.deleteUser() çağırmaz — çift silme hatasını önler.

    console.log(`[DeleteAccount] Firestore verisi silindi: ${uid} (${email})`);
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
