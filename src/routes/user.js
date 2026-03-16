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
//   • Server-side JWS verification: iOS sends the App Store signedTransactionInfo
//     (JWS token from StoreKit 2). Backend verifies the signature via Apple's
//     /verifyReceipt or decodes the JWS to extract the real productId.
//     If no JWS is provided, only downgrade to "free" is allowed.
router.post("/user/subscription/sync", authenticateUser, async (req, res) => {
  const { uid } = req.user;
  const { productId, signedTransactionInfo } = req.body || {};

  // Known product IDs → role mapping (com.examora.tier.interval format)
  const PRODUCT_ROLE_MAP = {
    "com.examora.pro.monthly":     "pro",
    "com.examora.pro.yearly":      "pro",
    "com.examora.premium.monthly": "premium",
    "com.examora.premium.yearly":  "premium",
  };

  // productId = null/undefined/empty → user has no active subscription → free
  // Downgrade to free is ALWAYS allowed without JWS (subscription expired/cancelled)
  if (!productId) {
    try {
      await setUserRole(uid, "free");
      await db.collection("users").doc(uid).set(
        { role: "free", subscriptionProductId: null, subscriptionSyncedAt: new Date() },
        { merge: true }
      );
      console.log(`[SubSync] uid=${uid} downgraded to 'free' (no active subscription)`);
      return res.json({ success: true, role: "free" });
    } catch (err) {
      console.error(`[SubSync] Error (uid=${uid}):`, err.message);
      return res.status(500).json({ error: "Failed to sync subscription role." });
    }
  }

  // Upgrading to pro/premium REQUIRES server-side verification
  const targetRole = PRODUCT_ROLE_MAP[productId] ?? null;

  if (targetRole === null) {
    return res.status(400).json({ error: "Unknown product identifier." });
  }

  // ── JWS Verification ──
  // StoreKit 2 sends a signedTransactionInfo (JWS) that we MUST verify.
  // Without it, we reject the upgrade to prevent abuse.
  if (!signedTransactionInfo || typeof signedTransactionInfo !== "string") {
    console.warn(`[SubSync] uid=${uid} attempted upgrade without JWS — rejected`);
    return res.status(403).json({
      error: "Transaction verification required. Please update the app.",
      code: "JWS_REQUIRED",
    });
  }

  try {
    // Decode and verify the JWS token
    const verifiedProductId = await verifyAppStoreJWS(signedTransactionInfo);

    if (!verifiedProductId) {
      console.warn(`[SubSync] uid=${uid} JWS verification failed`);
      return res.status(403).json({
        error: "Transaction verification failed.",
        code: "JWS_INVALID",
      });
    }

    // Ensure the productId in the JWS matches what the client claims
    if (verifiedProductId !== productId) {
      console.warn(`[SubSync] uid=${uid} productId mismatch: client=${productId}, JWS=${verifiedProductId}`);
      return res.status(403).json({
        error: "Product mismatch in transaction.",
        code: "PRODUCT_MISMATCH",
      });
    }

    const role = PRODUCT_ROLE_MAP[verifiedProductId];
    if (!role) {
      return res.status(400).json({ error: "Unknown product in transaction." });
    }

    // 1. Firebase custom claims güncelle (token'da role claim'i değişir)
    await setUserRole(uid, role);

    // 2. Firestore user dokümanındaki role alanını da güncelle
    await db.collection("users").doc(uid).set(
      { role, subscriptionProductId: verifiedProductId, subscriptionSyncedAt: new Date() },
      { merge: true }
    );

    console.log(`[SubSync] uid=${uid} role set to '${role}' (verified productId=${verifiedProductId})`);
    res.json({ success: true, role });
  } catch (err) {
    console.error(`[SubSync] Error (uid=${uid}):`, err.message);
    res.status(500).json({ error: "Failed to sync subscription role." });
  }
});

/**
 * Verify App Store StoreKit 2 JWS (JSON Web Signature) transaction.
 * Decodes the JWS payload and extracts the productId.
 *
 * In production, you should:
 * 1. Verify the JWS signature against Apple's public key (fetched from Apple's JWKS endpoint)
 * 2. Check that the bundleId matches your app
 * 3. Check the environment (Production vs Sandbox)
 *
 * For now, this performs basic payload extraction + validation.
 * TODO: Add full cryptographic verification with apple-app-store-server-library
 *
 * @param {string} jws - The signedTransactionInfo from StoreKit 2
 * @returns {string|null} - The verified productId, or null if invalid
 */
async function verifyAppStoreJWS(jws) {
  try {
    // JWS is a three-part base64url-encoded token: header.payload.signature
    const parts = jws.split(".");
    if (parts.length !== 3) return null;

    // Decode payload (part 1)
    const payloadBase64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payloadJson = Buffer.from(payloadBase64, "base64").toString("utf-8");
    const payload = JSON.parse(payloadJson);

    // Validate required fields
    if (!payload.productId || !payload.bundleId) return null;

    // Verify bundleId matches our app
    const EXPECTED_BUNDLE_ID = process.env.APP_BUNDLE_ID || "com.examora.app";
    if (payload.bundleId !== EXPECTED_BUNDLE_ID) {
      console.warn(`[JWS] bundleId mismatch: expected=${EXPECTED_BUNDLE_ID}, got=${payload.bundleId}`);
      return null;
    }

    // Verify environment (reject Sandbox in production if needed)
    if (process.env.NODE_ENV === "production" && payload.environment === "Sandbox") {
      console.warn("[JWS] Sandbox transaction rejected in production");
      return null;
    }

    // Check expiration: expiresDate is in milliseconds
    if (payload.expiresDate && payload.expiresDate < Date.now()) {
      console.warn("[JWS] Transaction expired");
      return null;
    }

    // TODO: Full cryptographic signature verification
    // Use Apple's JWKS: https://appleid.apple.com/auth/keys
    // or apple-app-store-server-library npm package

    return payload.productId;
  } catch (err) {
    console.error("[JWS] Verification error:", err.message);
    return null;
  }
}

// Admin: set user role — restricted to specific admin UIDs only.
// SECURITY: Only UIDs listed in ADMIN_UIDS env variable can use this endpoint.
// This prevents privilege escalation via premium users.
router.post("/user/role", authenticateUser, async (req, res) => {
  try {
    // Admin whitelist: comma-separated UIDs in environment variable
    const adminUids = (process.env.ADMIN_UIDS || "").split(",").map((s) => s.trim()).filter(Boolean);

    if (adminUids.length === 0) {
      // If no admins configured, endpoint is disabled entirely
      return res.status(403).json({ error: "Admin endpoint is disabled" });
    }

    if (!adminUids.includes(req.user.uid)) {
      console.warn(`[Admin] Unauthorized role change attempt by uid=${req.user.uid}`);
      return res.status(403).json({ error: "Insufficient permissions" });
    }

    const { targetUid, role } = req.body;
    if (!targetUid || !role) {
      return res.status(400).json({ error: "targetUid and role are required" });
    }

    if (!["free", "pro", "premium"].includes(role)) {
      return res.status(400).json({ error: "Invalid role. Must be: free, pro, or premium" });
    }

    await setUserRole(targetUid, role);
    console.log(`[Admin] uid=${req.user.uid} set role of ${targetUid} to '${role}'`);
    res.json({ success: true, uid: targetUid, role });
  } catch (err) {
    console.error("Set role error:", err.message);
    res.status(500).json({ error: "Failed to set user role" });
  }
});

module.exports = router;
