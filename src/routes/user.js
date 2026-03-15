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

    // Önce dokümanın mevcut olup olmadığını kontrol et.
    // createdAt yalnızca ilk kayıtta yazılır; mevcut değer asla üzerine yazılmaz.
    const snap = await userRef.get();
    const isNew = !snap.exists;

    await userRef.set(
      {
        uid,
        email: email || "",
        displayName: displayName || "",
        provider: provider || "unknown",
        role,
        lastSeenAt: now,
        ...(isNew ? { createdAt: now } : {}),
      },
      { merge: true }
    );

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

// Sync StoreKit subscription tier to Firebase custom claims.
// iOS calls this after every successful purchase and on app launch.
//
// Security model:
//   • Requires a valid Firebase ID token (authenticateUser).
//   • productId is validated against the known product list; unknown IDs are rejected.
//   • A user can only set their OWN role (uid from token, not from body).
//   • Rate-limited to 10 calls / hour per IP by the general limiter in index.js.
//
// This approach trusts the client's StoreKit result.  For higher-assurance
// apps, replace with App Store Server Notifications or JWS verification.
router.post("/user/subscription/sync", authenticateUser, async (req, res) => {
  const { uid } = req.user;
  const { productId } = req.body || {};

  // Known product IDs → role mapping
  const PRODUCT_ROLE_MAP = {
    examora_pro_monthly:     "pro",
    examora_pro_yearly:      "pro",
    examora_premium_monthly: "premium",
    examora_premium_yearly:  "premium",
  };

  // productId = null/undefined/empty → user has no active subscription → free
  const role = productId ? (PRODUCT_ROLE_MAP[productId] ?? null) : "free";

  if (role === null) {
    return res.status(400).json({ error: `Unknown productId: ${productId}` });
  }

  try {
    // 1. Firebase custom claims güncelle (token'da role claim'i değişir)
    await setUserRole(uid, role);

    // 2. Firestore user dokümanındaki role alanını da güncelle
    await db.collection("users").doc(uid).set(
      { role, subscriptionProductId: productId || null, subscriptionSyncedAt: new Date() },
      { merge: true }
    );

    console.log(`[SubSync] uid=${uid} role set to '${role}' (productId=${productId})`);
    res.json({ success: true, role });
  } catch (err) {
    console.error(`[SubSync] Error (uid=${uid}):`, err.message);
    res.status(500).json({ error: "Failed to sync subscription role." });
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
