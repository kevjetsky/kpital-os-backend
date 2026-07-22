import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Settings } from "../models/Settings.js";
import { sendVerificationEmail, sendPasswordResetEmail } from "../services/emailService.js";
import {
  getBearerToken,
  issueAuthToken,
  setAuthCookie,
  getAuthCookieOptions,
  getMainSettings,
  findAccountByEmail,
  normalizeEmail,
  countAccounts,
  asyncHandler
} from "../utils.js";
import { AUTH_COOKIE_NAME } from "../constants.js";

const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;

// Compared against when no account matches the submitted email, so a wrong
// email costs the same bcrypt work as a wrong password and the response time
// does not reveal which addresses are registered.
const NO_ACCOUNT_HASH = bcrypt.hashSync("no-account-placeholder", 10);
const MAX_VERIFICATION_ATTEMPTS = 5;

async function issueVerificationCode(settings, purpose = "email") {
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  settings.verificationCodeHash = await bcrypt.hash(code, 10);
  settings.verificationCodeExpiresAt = new Date(Date.now() + VERIFICATION_CODE_TTL_MS);
  settings.verificationAttempts = 0;
  settings.verificationPurpose = purpose;
  await settings.save();
  if (purpose === "reset") {
    await sendPasswordResetEmail(settings.email, code);
  } else {
    await sendVerificationEmail(settings.email, code);
  }
}

// Checks the pending code for the given purpose. Returns an error response
// descriptor or null when the code is valid; the caller clears the code.
async function checkPendingCode(settings, code, purpose) {
  const expired =
    settings.verificationPurpose !== purpose ||
    !settings.verificationCodeHash ||
    !settings.verificationCodeExpiresAt ||
    settings.verificationCodeExpiresAt.getTime() < Date.now();
  if (expired) {
    return { status: 410, message: "Code expired. Request a new one." };
  }

  if (settings.verificationAttempts >= MAX_VERIFICATION_ATTEMPTS) {
    return { status: 429, message: "Too many attempts. Request a new code." };
  }

  const codeValid = await bcrypt.compare(String(code || ""), settings.verificationCodeHash);
  if (!codeValid) {
    settings.verificationAttempts += 1;
    await settings.save();
    return { status: 401, message: "Incorrect code." };
  }

  return null;
}

function clearPendingCode(settings) {
  settings.verificationCodeHash = "";
  settings.verificationCodeExpiresAt = null;
  settings.verificationAttempts = 0;
  settings.verificationPurpose = "";
}

function emailMatches(settings, email) {
  return settings.email && settings.email === normalizeEmail(email);
}

function authResponse(req, token) {
  // Browser sessions use the HttpOnly cookie. Non-browser clients such as the
  // MCP worker have no Origin header and receive the bearer token explicitly.
  return req.headers.origin ? { ok: true } : { ok: true, token };
}

export const status = asyncHandler(async (req, res) => {
  // With multiple accounts, status can no longer describe "the" account: it only
  // reports whether this deployment has been initialised, plus whether the
  // caller's own token is still valid.
  const total = await countAccounts();
  const bootstrap = await getMainSettings();
  // Legacy documents predate email auth; setup attaches an email to them.
  const legacy = Boolean(total === 1 && bootstrap && !bootstrap.email);
  const requiresSetup = total === 0 || legacy;

  if (requiresSetup) {
    return res.json({ requiresSetup: true, legacy, authenticated: false });
  }

  const token = getBearerToken(req) || req.cookies[AUTH_COOKIE_NAME];
  if (!token) {
    return res.json({ requiresSetup: false, legacy: false, authenticated: false });
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return res.json({ requiresSetup: false, legacy: false, authenticated: true });
  } catch {
    return res.json({ requiresSetup: false, legacy: false, authenticated: false });
  }
});

export const setup = asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};
  const existing = await getMainSettings();

  if (!existing) {
    const passwordHash = await bcrypt.hash(String(password), 10);
    const settings = await Settings.create({
      key: "main",
      passwordHash,
      email: normalizeEmail(email)
    });
    await issueVerificationCode(settings);
    return res.status(201).json({ ok: true, requiresVerification: true });
  }

  const passwordValid = await bcrypt.compare(String(password || ""), existing.passwordHash);

  // Legacy document without an email: attach one, keeping the existing
  // password. Requires that password so a stranger can't claim the account.
  if (!existing.email) {
    if (!passwordValid) {
      return res.status(401).json({ message: "Invalid password." });
    }
    existing.email = normalizeEmail(email);
    existing.emailVerified = false;
    await issueVerificationCode(existing);
    return res.status(200).json({ ok: true, requiresVerification: true });
  }

  // Unverified account retrying setup (e.g. the first email failed to send):
  // same credentials get a fresh code instead of a conflict.
  if (!existing.emailVerified && emailMatches(existing, email) && passwordValid) {
    await issueVerificationCode(existing);
    return res.status(200).json({ ok: true, requiresVerification: true });
  }

  return res.status(409).json({ message: "Account already set up." });
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body ?? {};

  const settings = await findAccountByEmail(email);
  // Hash a throwaway value when no account matches so a wrong email and a wrong
  // password take the same time, and neither reveals which one was wrong.
  const passwordValid = settings
    ? await bcrypt.compare(String(password || ""), settings.passwordHash)
    : await bcrypt.compare(String(password || ""), NO_ACCOUNT_HASH);

  if (!settings || !passwordValid) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  if (!settings.emailVerified) {
    await issueVerificationCode(settings);
    return res.json({ ok: true, requiresVerification: true });
  }

  const token = issueAuthToken(settings._id);
  setAuthCookie(res, token);
  return res.json(authResponse(req, token));
});

export const verifyEmail = asyncHandler(async (req, res) => {
  const { email, code } = req.body ?? {};

  const settings = await findAccountByEmail(email);
  if (!settings) {
    return res.status(401).json({ message: "Invalid verification request." });
  }

  if (settings.emailVerified) {
    return res.status(400).json({ message: "Email is already verified. Please log in." });
  }

  const codeError = await checkPendingCode(settings, code, "email");
  if (codeError) {
    return res.status(codeError.status).json({ message: codeError.message });
  }

  settings.emailVerified = true;
  clearPendingCode(settings);
  await settings.save();

  const token = issueAuthToken(settings._id);
  setAuthCookie(res, token);
  return res.json(authResponse(req, token));
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body ?? {};

  const settings = await findAccountByEmail(email);
  if (!settings) {
    return res.json({ ok: true, requiresReset: true });
  }

  await issueVerificationCode(settings, "reset");
  return res.json({ ok: true, requiresReset: true });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { email, code, newPassword } = req.body ?? {};

  const settings = await findAccountByEmail(email);
  if (!settings) {
    return res.status(401).json({ message: "Invalid request." });
  }

  const codeError = await checkPendingCode(settings, code, "reset");
  if (codeError) {
    return res.status(codeError.status).json({ message: codeError.message });
  }

  settings.passwordHash = await bcrypt.hash(String(newPassword), 10);
  // Receiving the reset code proves ownership of the address.
  settings.emailVerified = true;
  clearPendingCode(settings);
  await settings.save();

  const token = issueAuthToken(settings._id);
  setAuthCookie(res, token);
  return res.json(authResponse(req, token));
});

export const resendCode = asyncHandler(async (req, res) => {
  const { email } = req.body ?? {};

  const settings = await findAccountByEmail(email);
  if (!settings) {
    return res.status(401).json({ message: "Invalid verification request." });
  }

  if (settings.emailVerified) {
    return res.status(400).json({ message: "Email is already verified. Please log in." });
  }

  await issueVerificationCode(settings);
  return res.json({ ok: true, requiresVerification: true });
});

// POST /api/auth/signup — provision an additional business account.
//
// Gated by SIGNUP_INVITE_CODE: this app holds real financial records, so it is
// not open registration. With no code configured the route stays closed rather
// than defaulting to open, so a missing env var can never silently expose it.
export const signup = asyncHandler(async (req, res) => {
  const { email, password, inviteCode } = req.body ?? {};

  const expected = String(process.env.SIGNUP_INVITE_CODE || "");
  if (!expected) {
    return res.status(403).json({ message: "Account creation is disabled." });
  }

  // Constant-time compare so the code cannot be recovered byte-by-byte from
  // response timings.
  const supplied = String(inviteCode || "");
  const expectedBuf = Buffer.from(expected);
  const suppliedBuf = Buffer.from(supplied);
  const codeValid =
    expectedBuf.length === suppliedBuf.length && crypto.timingSafeEqual(expectedBuf, suppliedBuf);
  if (!codeValid) {
    return res.status(403).json({ message: "Invalid invite code." });
  }

  const normalized = normalizeEmail(email);
  const existing = await findAccountByEmail(normalized);
  if (existing) {
    return res.status(409).json({ message: "An account with this email already exists." });
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  let settings;
  try {
    settings = await Settings.create({ passwordHash, email: normalized });
  } catch (error) {
    // Unique index on email: two simultaneous signups for the same address.
    if (error?.code === 11000) {
      return res.status(409).json({ message: "An account with this email already exists." });
    }
    throw error;
  }

  // A new account starts empty and isolated — no data is copied from any other
  // account, and every query is scoped by its accountId.
  //
  // The account is already persisted, so a failed send must not surface as an
  // error: the caller would retry and hit "email already exists" forever, locked
  // out of an account they just created. Report it and let them request a new
  // code instead.
  try {
    await issueVerificationCode(settings);
  } catch (error) {
    console.error("Signup verification email failed:", error?.message || error);
    return res.status(201).json({
      ok: true,
      requiresVerification: true,
      emailSent: false,
      message: "Account created, but the verification email could not be sent. Request a new code."
    });
  }

  return res.status(201).json({ ok: true, requiresVerification: true, emailSent: true });
});

export const logout = (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions());
  res.json({ ok: true });
};
