// Service area (an optional GeoJSON polygon plus a drive-time cap from home
// base) and the signed areaToken that proves a later request already passed it.
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// Ray casting on one ring of [lng, lat] pairs.
function inRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses = yi > point.lat !== yj > point.lat && point.lng < ((xj - xi) * (point.lat - yi)) / (yj - yi) + xi;
    if (crosses) inside = !inside;
  }
  return inside;
}

// A polygon is its outer ring minus its holes.
const inPolygon = (point, rings) =>
  Array.isArray(rings) && rings.length > 0 && inRing(point, rings[0]) && !rings.slice(1).some((hole) => inRing(point, hole));

export function pointInGeoJson(point, geo) {
  if (!geo || typeof geo !== "object") return false;
  switch (geo.type) {
    case "FeatureCollection":
      return (geo.features || []).some((feature) => pointInGeoJson(point, feature));
    case "Feature":
      return pointInGeoJson(point, geo.geometry);
    case "GeometryCollection":
      return (geo.geometries || []).some((geometry) => pointInGeoJson(point, geometry));
    case "Polygon":
      return inPolygon(point, geo.coordinates);
    case "MultiPolygon":
      return (geo.coordinates || []).some((rings) => inPolygon(point, rings));
    default:
      return false;
  }
}

// A stable key for "the same address", so the per-address cap is not dodged by
// spacing or capitals. Hashed: the key is stored and logged without the address.
export function addressKeyOf(address) {
  const compact = String(address || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  return createHash("sha256").update(compact).digest("hex").slice(0, 20);
}

const b64 = (buffer) => Buffer.from(buffer).toString("base64url");
const sign = (body, secret) => createHmac("sha256", secret).update(body).digest();

// payload: { a: address, p: { lat, lng }, k: addressKey }. Good for 30 minutes.
export function signAreaToken(payload, secret, { ttlMinutes = 30, now = Date.now() } = {}) {
  const body = b64(JSON.stringify({ ...payload, exp: now + ttlMinutes * 60000 }));
  return `${body}.${b64(sign(body, secret))}`;
}

export function verifyAreaToken(token, secret, { now = Date.now() } = {}) {
  if (typeof token !== "string" || token.length > 2000 || !secret) return null;
  const [body, mac] = token.split(".");
  if (!body || !mac) return null;
  const expected = sign(body, secret);
  const given = Buffer.from(mac, "base64url");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (!payload || typeof payload.exp !== "number" || payload.exp < now) return null;
    if (typeof payload.a !== "string" || !payload.p || !Number.isFinite(payload.p.lat) || !Number.isFinite(payload.p.lng)) return null;
    return payload;
  } catch {
    return null;
  }
}
