// Machine-to-machine auth for scheduled jobs (e.g. the Cloudflare cron trigger).
// Uses a shared secret header rather than the owner JWT. Secure by default: if
// CRON_SECRET is unset, every request is rejected.
export function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    return res.status(503).json({ message: "Cron is not configured." });
  }

  const provided = req.get("x-cron-secret") || "";
  if (provided !== expected) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  return next();
}
