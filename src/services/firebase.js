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
  verifyToken,
  getUserRole,
  setUserRole,
  canUploadDocuments,
  canUseDocuments,
};
