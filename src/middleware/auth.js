const { verifyToken } = require("../services/firebase");

/**
 * Validate API key (for service-to-service calls).
 * SECURITY: If API_KEY is not configured, reject the request (fail-closed).
 */
function validateApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  const expected = process.env.API_KEY;

  // Fail-closed: if API_KEY is not configured, reject anonymous requests
  if (!expected) {
    console.warn("[Auth] API_KEY not configured — rejecting anonymous request");
    return res.status(503).json({ error: "Service not configured for anonymous access" });
  }

  if (!apiKey || apiKey !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

/**
 * Authenticate Firebase user via Bearer token
 * Sets req.user = { uid, email, role, deviceId }
 *
 * Role is read directly from the token's custom claims — no extra admin API call.
 * verifyIdToken() works with just projectId; no service account credential required.
 *
 * deviceId: iOS Keychain'den gelen kalıcı cihaz kimliği.
 * Anonim kullanıcılar için kullanım takibi deviceId üzerinden yapılır,
 * böylece uygulama silinip yüklense bile limitler korunur.
 */
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "Missing or invalid authorization header",
    });
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decoded = await verifyToken(idToken);

    // Role is embedded in the token's custom claims (set via setUserRole / Firebase Admin).
    // Falls back to "free" for new users who don't have a role claim yet.
    const role = decoded.role || "free";

    // deviceId: iOS Keychain'den gelen kalıcı cihaz kimliği
    const deviceId = req.headers["x-device-id"] || null;

    req.user = {
      uid: decoded.uid,
      email: decoded.email || "",
      role,
      deviceId,
      isAnonymous: !decoded.email,
    };

    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    // SECURITY: Do not expose internal details or configuration hints
    return res.status(401).json({
      error: "Invalid or expired token",
    });
  }
}

/**
 * Combined auth: tries Firebase token first, falls back to API key.
 * SECURITY: Anonymous access requires valid API key (fail-closed).
 */
function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authenticateUser(req, res, next);
  }

  // Fallback to API key (for non-user calls)
  const deviceId = req.headers["x-device-id"] || null;
  req.user = { uid: "anonymous", email: "", role: "free", deviceId, isAnonymous: true };
  return validateApiKey(req, res, next);
}

module.exports = { validateApiKey, authenticateUser, authenticateRequest };
