import rateLimit, { ipKeyGenerator } from "express-rate-limit";

const FIFTEEN_MINUTES = 15 * 60 * 1000;
const tooMany = { message: "Too many requests, please try again later." };
// The client address comes from app.set("trust proxy", trustAppEngineProxy);
// Google also sets a Forwarded header, which is deliberately not read.
const validate = { forwardedHeader: false };
const skip = () => process.env.NODE_ENV === "test";

// Sign-in and code endpoints, per client address: 20 tries in 15 minutes.
const perClient = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: tooMany,
  validate,
  skip
});

// And a ceiling for everyone together, so spreading guesses over many
// addresses does not buy unlimited tries. Successful requests do not count,
// so the owner signing in normally never uses it up.
const everyone = rateLimit({
  windowMs: FIFTEEN_MINUTES,
  limit: 300,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: () => "all",
  skipSuccessfulRequests: true,
  message: tooMany,
  validate,
  skip
});

export const authRateLimiter = [perClient, everyone];

/**
 * A per-account limit for signed-in routes that spend something (paid Google
 * calls, free public lookups). Falls back to the client address.
 */
export function accountRateLimiter({ limit, windowMs = 60 * 1000, message }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.accountId || ipKeyGenerator(req.ip || "unknown")),
    message: typeof message === "string" ? { message } : message,
    validate
  });
}
