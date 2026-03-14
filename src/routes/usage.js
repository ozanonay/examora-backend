const express = require("express");
const { authenticateRequest } = require("../middleware/auth");
const { getRemainingSeconds, resolveUsageKey } = require("../services/firebase");

const router = express.Router();

/**
 * GET /api/usage/remaining
 * Returns the user's monthly recording usage.
 *
 * Anonim kullanıcılar için deviceId (X-Device-Id header) tabanlı takip yapar.
 * Bu sayede uygulama silinip tekrar yüklense bile kullanım limitleri korunur.
 *
 * Response:
 * {
 *   remaining: number,  // seconds left this month
 *   used:      number,  // seconds consumed this month
 *   limit:     number,  // total monthly limit for this role
 *   role:      string,  // user's current role
 * }
 */
router.get("/usage/remaining", authenticateRequest, async (req, res) => {
  try {
    const user = req.user;
    const usageKey = resolveUsageKey(user);
    const { remaining, used, limit } = await getRemainingSeconds(usageKey, user.role);
    res.json({ remaining, used, limit, role: user.role });
  } catch (err) {
    console.error("Usage endpoint error:", err.message);
    res.status(500).json({ error: "Could not fetch usage data" });
  }
});

module.exports = router;
