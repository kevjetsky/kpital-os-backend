import jwt from "jsonwebtoken";
import { getBearerToken } from "../utils.js";
import { AUTH_COOKIE_NAME } from "../constants.js";
import { Settings } from "../models/Settings.js";

// Sessions can be ended. Every token carries the account's session number
// (`se`) from when it was issued; a password reset or "sign out everywhere"
// bumps the number, and every older token stops working. Tokens minted before
// this existed carry none and count as 0, so they keep working until the first
// bump. The number is read from the database and remembered for a short while
// per server, so another server can accept an ended token for up to 30 seconds.
const EPOCH_TTL_MS = 30 * 1000;
const epochs = new Map();

export function rememberSessionEpoch(accountId, value) {
  epochs.set(String(accountId), { value, at: Date.now() });
}

export function clearSessionEpochs() {
  epochs.clear();
}

// The account's current session number, or null when the account is gone.
async function sessionEpochOf(accountId) {
  const key = String(accountId);
  const hit = epochs.get(key);
  if (hit && Date.now() - hit.at < EPOCH_TTL_MS) return hit.value;
  const account = await Settings.findById(key).select("sessionEpoch").lean();
  const value = account ? account.sessionEpoch || 0 : null;
  if (value !== null) rememberSessionEpoch(key, value);
  return value;
}

/**
 * The token's claims when it is a live session, otherwise { error } with the
 * reason to show.
 */
export async function verifySession(token) {
  let payload;
  try {
    payload = jwt.verify(token, process.env.JWT_SECRET);
  } catch {
    return { error: "Unauthorized" };
  }
  // Tokens issued before multi-tenancy carry no accountId. They must be
  // rejected rather than tolerated: mongoose strips undefined values from
  // filters, so find({ accountId: undefined }) silently matches every
  // account's documents. Rejecting forces a re-login that mints a scoped
  // token.
  if (!payload.accountId) return { error: "Session is out of date. Please sign in again." };
  let current;
  try {
    current = await sessionEpochOf(payload.accountId);
  } catch {
    // An id that is not an ObjectId cannot be an account.
    return { error: "Unauthorized" };
  }
  if (current === null) return { error: "Unauthorized" };
  if ((payload.se || 0) !== current) return { error: "This session was signed out. Please sign in again." };
  return { payload };
}

export function requireAuth(req, res, next) {
  const token = getBearerToken(req) || req.cookies[AUTH_COOKIE_NAME];

  if (!token) {
    return res.status(401).json({ message: "Unauthorized" });
  }

  return verifySession(token).then(({ payload, error }) => {
    if (error) return res.status(401).json({ message: error });
    req.user = payload;
    req.accountId = payload.accountId;
    return next();
  }, next);
}
