import jwt from "jsonwebtoken";

const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "kpital_token";

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = header.slice(7).trim();
  return token || null;
}

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
