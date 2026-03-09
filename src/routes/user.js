const express = require("express");
const { authenticateRequest } = require("../middleware/auth");
const { setUserRole } = require("../services/firebase");

const router = express.Router();

// Get current user profile
router.get("/user/me", authenticateRequest, async (req, res) => {
  res.json({
    uid: req.user.uid,
    email: req.user.email,
    role: req.user.role,
  });
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
