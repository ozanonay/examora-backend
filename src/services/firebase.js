const admin = require("firebase-admin");

const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON)
  : null;

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: "examora-app",
  });
} else {
  admin.initializeApp({ projectId: "examora-app" });
}

const auth = admin.auth();
const db = admin.firestore();

// Monthly recording limits in seconds per role
const MONTHLY_LIMITS = {
  anon:    45,    //  45 seconds
  free:    300,   //  5 minutes
  pro:     900,   // 15 minutes
  premium: 2700,  // 45 minutes
};

// Monthly document upload limits per role (PDF + TXT toplam)
const MONTHLY_DOC_LIMITS = {
  free:    0,   // Yükleme yapamaz
  anon:    0,
  pro:     3,   // Ayda 3 dosya
  premium: 10,  // Ayda 10 dosya
};

/**
 * Returns the YYYY-MM key for the current month (UTC)
 */
function currentMonthKey() {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/**
 * Anonim kullanıcılar için kullanım takip anahtarını belirler.
 * deviceId varsa → "device:{deviceId}" (uygulama silinse bile aynı kalır)
 * deviceId yoksa → Firebase UID (eski davranış, fallback)
 *
 * Kayıtlı kullanıcılar (email, Apple, Google) her zaman UID kullanır.
 *
 * @param {object} user - { uid, role, deviceId, isAnonymous }
 * @returns {string} Firestore'da kullanılacak usage tracking key
 */
function resolveUsageKey(user) {
  // Anonim kullanıcı + deviceId varsa → cihaz bazlı takip
  if (user.isAnonymous && user.deviceId) {
    return `device:${user.deviceId}`;
  }
  // Kayıtlı kullanıcı veya deviceId yok → UID bazlı takip
  return user.uid;
}

/**
 * Bu ay kullanıcının kaç doküman yüklediğini döner.
 * @param {string} uid
 * @returns {Promise<number>}
 */
async function getMonthlyDocCount(uid) {
  const doc = await db
    .collection("users")
    .doc(uid)
    .collection("docUploads")
    .doc(currentMonthKey())
    .get();
  return doc.exists ? (doc.data().count || 0) : 0;
}

/**
 * Doküman yükleme sayacını 1 artırır.
 * @param {string} uid
 */
async function incrementMonthlyDocCount(uid) {
  const ref = db
    .collection("users")
    .doc(uid)
    .collection("docUploads")
    .doc(currentMonthKey());
  await ref.set(
    {
      count: admin.firestore.FieldValue.increment(1),
      lastUploadAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );
}

/**
 * Returns how many seconds the user has consumed this month.
 * @param {string} uid - usage tracking key (uid veya device:xxx)
 * @returns {Promise<number>}
 */
async function getMonthlyUsageSeconds(uid) {
  const doc = await db
    .collection("users")
    .doc(uid)
    .collection("usage")
    .doc(currentMonthKey())
    .get();
  return doc.exists ? (doc.data().seconds || 0) : 0;
}

/**
 * Increments the user's monthly usage by `seconds`.
 * Uses Firestore increment so concurrent requests don't stomp on each other.
 * @param {string} uid - usage tracking key (uid veya device:xxx)
 * @param {number} seconds
 */
async function addMonthlyUsageSeconds(uid, seconds) {
  if (!seconds || seconds <= 0) return;
  const ref = db
    .collection("users")
    .doc(uid)
    .collection("usage")
    .doc(currentMonthKey());
  await ref.set(
    { seconds: admin.firestore.FieldValue.increment(seconds) },
    { merge: true }
  );
}

/**
 * Returns remaining seconds for the user this month.
 * Anonim kullanıcılar için deviceId tabanlı takip kullanır.
 *
 * @param {string} usageKey - resolveUsageKey() sonucu
 * @param {string} role
 * @returns {Promise<{ remaining: number, used: number, limit: number }>}
 */
async function getRemainingSeconds(usageKey, role) {
  const limit = MONTHLY_LIMITS[role] ?? MONTHLY_LIMITS["free"];
  const used = await getMonthlyUsageSeconds(usageKey);
  const remaining = Math.max(0, limit - used);
  return { remaining, used, limit };
}

/**
 * Verify Firebase ID token and return decoded user
 */
async function verifyToken(idToken) {
  return auth.verifyIdToken(idToken);
}

/**
 * Get user's custom claims (role, etc.)
 */
async function getUserRole(uid) {
  const user = await auth.getUser(uid);
  return user.customClaims?.role || "free";
}

/**
 * Set user role (free, pro, premium)
 */
async function setUserRole(uid, role) {
  await auth.setCustomUserClaims(uid, { role });
}

/**
 * Check if user can upload documents (pro or premium only)
 */
function canUploadDocuments(role) {
  return role === "pro" || role === "premium";
}

/**
 * Check if user can use specialty documents in answers
 */
function canUseDocuments(role) {
  return role === "pro" || role === "premium";
}

module.exports = {
  auth,
  db,
  verifyToken,
  getUserRole,
  setUserRole,
  canUploadDocuments,
  canUseDocuments,
  MONTHLY_LIMITS,
  MONTHLY_DOC_LIMITS,
  resolveUsageKey,
  getMonthlyUsageSeconds,
  addMonthlyUsageSeconds,
  getRemainingSeconds,
  getMonthlyDocCount,
  incrementMonthlyDocCount,
};
