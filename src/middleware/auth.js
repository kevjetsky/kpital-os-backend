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
    req.user = payload;
    return next();
  } catch {
    return res.status(401).json({ message: "Unauthorized" });
  }
}
