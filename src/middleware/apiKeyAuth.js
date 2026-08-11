/**
 * If API_KEY is set in the environment, every request must include a
 * matching x-api-key header. If it's not set, this middleware does
 * nothing — local development stays exactly as it was.
 *
 * This is intentionally minimal: one shared secret, not per-user accounts.
 * Good enough to stop a public deployment from being wide open to anyone
 * who finds the URL; not a substitute for real auth if you ever store
 * data on behalf of multiple distinct users who shouldn't see each other's work.
 */
function apiKeyAuth(req, res, next) {
  const requiredKey = process.env.API_KEY;
  if (!requiredKey) return next(); // no key configured — auth disabled

  if (req.path === "/health") return next(); // always allow health checks

  const providedKey = req.get("x-api-key");
  if (providedKey !== requiredKey) {
    return res.status(401).json({ error: "Missing or invalid x-api-key header." });
  }
  next();
}

module.exports = { apiKeyAuth };
