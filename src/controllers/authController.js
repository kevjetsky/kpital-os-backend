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
  asyncHandler
} from "../utils.js";
import { AUTH_COOKIE_NAME } from "../constants.js";

const VERIFICATION_CODE_TTL_MS = 10 * 60 * 1000;
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
  return settings.email && settings.email === email;
}

export const status = asyncHandler(async (req, res) => {
  const settings = await getMainSettings();
  // Legacy documents predate email auth; setup attaches an email to them.
  const legacy = Boolean(settings && !settings.email);
  const requiresSetup = !settings || legacy;

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
    const settings = await Settings.create({ key: "main", passwordHash, email });
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
    existing.email = email;
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

  const settings = await getMainSettings();
  if (!settings || !settings.email) {
    return res.status(400).json({ message: "Run initial setup first." });
  }

  const passwordValid = await bcrypt.compare(String(password || ""), settings.passwordHash);
  if (!emailMatches(settings, email) || !passwordValid) {
    return res.status(401).json({ message: "Invalid email or password." });
  }

  if (!settings.emailVerified) {
    await issueVerificationCode(settings);
    return res.json({ ok: true, requiresVerification: true });
  }

  const token = issueAuthToken();
  setAuthCookie(res, token);
  return res.json({ ok: true, token });
});

export const verifyEmail = asyncHandler(async (req, res) => {
  const { email, code } = req.body ?? {};

  const settings = await getMainSettings();
  if (!settings || !emailMatches(settings, email)) {
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

  const token = issueAuthToken();
  setAuthCookie(res, token);
  return res.json({ ok: true, token });
});

export const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body ?? {};

  const settings = await getMainSettings();
  if (!settings || !emailMatches(settings, email)) {
    return res.status(401).json({ message: "Invalid request." });
  }

  await issueVerificationCode(settings, "reset");
  return res.json({ ok: true, requiresReset: true });
});

export const resetPassword = asyncHandler(async (req, res) => {
  const { email, code, newPassword } = req.body ?? {};

  const settings = await getMainSettings();
  if (!settings || !emailMatches(settings, email)) {
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

  const token = issueAuthToken();
  setAuthCookie(res, token);
  return res.json({ ok: true, token });
});

export const resendCode = asyncHandler(async (req, res) => {
  const { email } = req.body ?? {};

  const settings = await getMainSettings();
  if (!settings || !emailMatches(settings, email)) {
    return res.status(401).json({ message: "Invalid verification request." });
  }

  if (settings.emailVerified) {
    return res.status(400).json({ message: "Email is already verified. Please log in." });
  }

  await issueVerificationCode(settings);
  return res.json({ ok: true, requiresVerification: true });
});

export const logout = (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions());
  res.json({ ok: true });
};
