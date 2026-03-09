const { verifyToken, getUserRole } = require("../services/firebase");

/**
 * Validate API key (for service-to-service calls)
 */
function validateApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  const expected = process.env.API_KEY;

  if (!expected) {
    return next();
  }

  if (!apiKey || apiKey !== expected) {
    return res.status(401).json({ error: "Unauthorized: invalid API key" });
  }

  next();
}

/**
 * Authenticate Firebase user via Bearer token
 * Sets req.user = { uid, email, role }
 */
async function authenticateUser(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Missing or invalid authorization header" });
  }

  const idToken = authHeader.split("Bearer ")[1];

  try {
    const decoded = await verifyToken(idToken);
    const role = await getUserRole(decoded.uid);

    req.user = {
      uid: decoded.uid,
      email: decoded.email || "",
      role,
    };

    next();
  } catch (err) {
    console.error("Auth error:", err.message);
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

/**
 * Combined auth: tries Firebase token first, falls back to API key
 */
function authenticateRequest(req, res, next) {
  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith("Bearer ")) {
    return authenticateUser(req, res, next);
  }

  // Fallback to API key (for non-user calls)
  req.user = { uid: "anonymous", email: "", role: "free" };
  return validateApiKey(req, res, next);
}

module.exports = { validateApiKey, authenticateUser, authenticateRequest };
