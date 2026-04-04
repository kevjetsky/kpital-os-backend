import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { Settings } from "../models/Settings.js";
import {
  getBearerToken,
  issueAuthToken,
  setAuthCookie,
  getAuthCookieOptions,
  getMainSettings,
  asyncHandler
} from "../utils.js";
import { AUTH_COOKIE_NAME } from "../constants.js";

export const status = asyncHandler(async (req, res) => {
  const settings = await getMainSettings();
  const requiresSetup = !settings;

  if (requiresSetup) {
    return res.json({ requiresSetup: true, authenticated: false });
  }

  const token = getBearerToken(req) || req.cookies[AUTH_COOKIE_NAME];
  if (!token) {
    return res.json({ requiresSetup: false, authenticated: false });
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return res.json({ requiresSetup: false, authenticated: true });
  } catch {
    return res.json({ requiresSetup: false, authenticated: false });
  }
});

export const setup = asyncHandler(async (req, res) => {
  const { password } = req.body ?? {};

  const existing = await getMainSettings();
  if (existing) {
    return res.status(409).json({ message: "Password already set." });
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  await Settings.create({ key: "main", passwordHash });
  const token = issueAuthToken();
  setAuthCookie(res, token);

  return res.status(201).json({ ok: true, token });
});

export const login = asyncHandler(async (req, res) => {
  const { password } = req.body ?? {};

  const settings = await getMainSettings();
  if (!settings) {
    return res.status(400).json({ message: "Run initial setup first." });
  }

  const isValid = await bcrypt.compare(String(password || ""), settings.passwordHash);
  if (!isValid) {
    return res.status(401).json({ message: "Invalid password." });
  }

  const token = issueAuthToken();
  setAuthCookie(res, token);
  return res.json({ ok: true, token });
});

export const logout = (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions());
  res.json({ ok: true });
};
