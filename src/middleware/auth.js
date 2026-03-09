function validateApiKey(req, res, next) {
  const apiKey = req.headers["x-api-key"];
  const expected = process.env.API_KEY;

  if (!expected) {
    console.warn("API_KEY not set in environment — skipping auth");
    return next();
  }

  if (!apiKey || apiKey !== expected) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

module.exports = { validateApiKey };
