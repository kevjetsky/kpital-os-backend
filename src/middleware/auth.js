import jwt from "jsonwebtoken";
import { getBearerToken } from "../utils.js";
import { AUTH_COOKIE_NAME } from "../constants.js";

export function requireAuth(req, res, next) {
  const token = getBearerToken(req) || req.cookies[AUTH_COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);

    // Tokens issued before multi-tenancy carry no accountId. They must be
    // rejected rather than tolerated: mongoose strips undefined values from
    // filters, so find({ accountId: undefined }) silently matches every
    // account's documents. Rejecting forces a re-login that mints a scoped
    // token.
    if (!payload.accountId) {
      return res.status(401).json({ message: "Session is out of date. Please sign in again." });
    }

    req.user = payload;
    req.accountId = payload.accountId;
    return next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
}
