import crypto from "node:crypto";

// Constant-time comparison of two secrets: both are hashed first, so neither
// their contents nor their lengths show in how long the check takes.
export function secretsMatch(provided, expected) {
  const digest = (value) => crypto.createHash("sha256").update(String(value)).digest();
  return crypto.timingSafeEqual(digest(provided), digest(expected));
}

/**
 * Machine-to-machine auth by a shared secret in a header, for callers that
 * cannot hold the owner's sign-in (the Cloudflare cron trigger, carrier
 * webhooks). Secure by default: with the variable unset every request is
 * refused rather than accepted.
 */
export function requireSharedSecret({ envName, header, notConfigured }) {
  return (req, res, next) => {
    const expected = process.env[envName];
    if (!expected) {
      return res.status(503).json({ message: notConfigured });
    }
    if (!secretsMatch(req.get(header) || "", expected)) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    return next();
  };
}
