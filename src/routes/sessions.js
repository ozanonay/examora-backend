const express = require("express");
const { authenticateRequest } = require("../middleware/auth");
const { listExamSessions, getExamSession } = require("../services/blobStorage");

const router = express.Router();

// List exam sessions for current user
router.get("/sessions", authenticateRequest, async (req, res) => {
  try {
    const user = req.user;

    if (user.role !== "pro" && user.role !== "premium") {
      return res.status(403).json({ error: "Exam history requires Pro or Premium plan" });
    }

    const sessions = await listExamSessions(user.uid);
    res.json({ count: sessions.length, sessions });
  } catch (err) {
    console.error("Sessions list error:", err.message);
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

// Get a specific exam session
router.get("/sessions/:sessionId", authenticateRequest, async (req, res) => {
  try {
    const user = req.user;
    const { sessionId } = req.params;

    if (user.role !== "pro" && user.role !== "premium") {
      return res.status(403).json({ error: "Exam history requires Pro or Premium plan" });
    }

    const session = await getExamSession(user.uid, sessionId);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    res.json(session);
  } catch (err) {
    console.error("Session get error:", err.message);
    res.status(500).json({ error: "Failed to get session" });
  }
});

module.exports = router;
