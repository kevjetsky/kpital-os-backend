// Address lookup for records, so jobs can be grouped by area.
//
// Two free services, neither needing a key:
//  - Photon (OpenStreetMap) suggests streets as the owner types. Its house
//    numbers and ZIP codes are patchy in Houston, so it is only trusted for the
//    street and city.
//  - The US Census geocoder turns a full address into its exact ZIP code and
//    coordinates. That is what the area numbers are built on.
//
// Every call is best-effort: a slow or failing service returns nothing and the
// record is saved with whatever the address text itself says.
const PHOTON_URL = "https://photon.komoot.io";
const CENSUS_URL = "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress";
const USER_AGENT = "KpitalOS/1.0 (address lookup)";

const CACHE_LIMIT = 300;
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map();

// GEO_LOOKUP=off turns every outside call off (the test suite runs that way).
export function lookupEnabled() {
  return String(process.env.GEO_LOOKUP || "").toLowerCase() !== "off";
}

// Suggestions lean towards this point and stay inside this box. Defaults to
// Houston and the area around it.
function bias() {
  const lat = Number(process.env.GEO_CENTER_LAT);
  const lon = Number(process.env.GEO_CENTER_LON);
  return {
    lat: Number.isFinite(lat) && lat !== 0 ? lat : 29.7604,
    lon: Number.isFinite(lon) && lon !== 0 ? lon : -95.3698,
    bbox: process.env.GEO_BBOX || "-96.4,29.0,-94.6,30.6"
  };
}

async function getJson(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": USER_AGENT },
      signal: controller.signal
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function cached(key, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = await load();
  // Failures are not remembered, so a blip does not blank an address for an hour.
  if (value !== null && value !== undefined) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), value });
  }
  return value;
}

export function clearGeoCache() {
  cache.clear();
}

const STATE_CODES = { texas: "TX", louisiana: "LA", oklahoma: "OK", arkansas: "AR", "new mexico": "NM" };

function stateCode(value) {
  const text = String(value || "").trim();
  if (/^[A-Za-z]{2}$/.test(text)) return text.toUpperCase();
  return STATE_CODES[text.toLowerCase()] || text;
}

// Street words that read wrong in plain title case.
const KEEP_UPPER = new Set(["N", "S", "E", "W", "NE", "NW", "SE", "SW", "FM", "TX", "US", "IH", "SH", "CR", "PO"]);

export function titleCaseAddress(value) {
  return String(value || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => {
      const bare = word.replace(/[^a-z0-9]/g, "");
      if (KEEP_UPPER.has(bare.toUpperCase())) return word.toUpperCase();
      if (/^\d/.test(word)) return word; // 1st, 2400, 4b
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function zipOf(value) {
  return (String(value || "").match(/\b(\d{5})\b/) || [])[1] || "";
}

// One Photon result as an address suggestion, or null when it is not a place a
// job could be at (a park with no street, a result outside the US).
function toSuggestion(feature, query) {
  const p = feature?.properties || {};
  const [lng, lat] = feature?.geometry?.coordinates || [];
  if (p.countrycode && String(p.countrycode).toUpperCase() !== "US") return null;

  const street = p.street || (p.type === "street" ? p.name : "");
  if (!street) return null;

  // The number the owner typed wins: Photon often knows the street but not the
  // house, and the Census lookup places the exact number afterwards.
  const typedNumber = (String(query).match(/^\s*(\d+[A-Za-z]?)\s/) || [])[1] || "";
  const number = typedNumber || p.housenumber || "";
  const exactHouse = Boolean(p.housenumber) && (!typedNumber || typedNumber === String(p.housenumber));

  const city = p.city || "";
  const state = stateCode(p.state);
  // A street-level match can sit in any of the ZIP codes a long road crosses,
  // so its ZIP is left off until the exact address has been looked up.
  const zip = exactHouse ? zipOf(p.postcode) : "";
  const neighborhood = [p.locality, p.district].find((name) => name && name !== city) || "";

  const line1 = [number, street].filter(Boolean).join(" ");
  const line2 = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return {
    label: [line1, line2].filter(Boolean).join(", "),
    line1,
    line2,
    city,
    state,
    zip,
    neighborhood,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null
  };
}

/** Address suggestions for what has been typed so far. Never throws; [] when there is nothing to offer. */
export async function autocomplete(query) {
  const text = String(query || "").trim().replace(/\s+/g, " ");
  if (text.length < 4 || !lookupEnabled()) return [];

  return (
    (await cached(`a:${text.toLowerCase()}`, async () => {
      const { lat, lon, bbox } = bias();
      const params = new URLSearchParams({ q: text, lat: String(lat), lon: String(lon), limit: "10", lang: "en", bbox });
      const data = await getJson(`${PHOTON_URL}/api/?${params}`, 2500);
      if (!data) return null;

      const seen = new Set();
      const suggestions = [];
      for (const feature of data.features || []) {
        const suggestion = toSuggestion(feature, text);
        if (!suggestion) continue;
        // One line per street and city: the segments of a long road differ only
        // in a ZIP that is not shown.
        const key = `${suggestion.line1}|${suggestion.city}`.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        suggestions.push(suggestion);
        if (suggestions.length === 5) break;
      }
      return suggestions;
    })) || []
  );
}

async function neighborhoodAt(lat, lng) {
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), lang: "en" });
  const data = await getJson(`${PHOTON_URL}/reverse?${params}`, 1200);
  const p = data?.features?.[0]?.properties;
  if (!p) return "";
  return [p.locality, p.district].find((name) => name && name !== p.city) || "";
}

/**
 * The exact ZIP code, city and coordinates of a full address, or null when it
 * cannot be placed (too little to go on, no such address, or the lookup is down).
 */
export async function resolveAddress(address) {
  const text = String(address || "").trim().replace(/\s+/g, " ");
  if (text.length < 6 || !/\d/.test(text) || !/[A-Za-z]/.test(text) || !lookupEnabled()) return null;

  return cached(`r:${text.toLowerCase()}`, async () => {
    const params = new URLSearchParams({ address: text, benchmark: "Public_AR_Current", format: "json" });
    const data = await getJson(`${CENSUS_URL}?${params}`, 2500);
    const match = data?.result?.addressMatches?.[0];
    if (!match) return null;

    const lat = Number(match.coordinates?.y);
    const lng = Number(match.coordinates?.x);
    const parts = match.addressComponents || {};
    const [street] = String(match.matchedAddress || "").split(",");
    const city = titleCaseAddress(parts.city);
    const state = stateCode(parts.state);
    const zip = zipOf(parts.zip);
    const line1 = titleCaseAddress(street);

    return {
      address: [line1, [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ")].filter(Boolean).join(", "),
      city,
      state,
      zip,
      neighborhood: Number.isFinite(lat) && Number.isFinite(lng) ? await neighborhoodAt(lat, lng) : "",
      lat: Number.isFinite(lat) ? lat : null,
      lng: Number.isFinite(lng) ? lng : null
    };
  });
}

/** What the address text itself says, for when no lookup is available: "..., City, ST 77002". */
export function parseAddressText(address) {
  const text = String(address || "");
  const tail = text.match(/,\s*([^,]+?),?\s+([A-Za-z]{2})\s+(\d{5})(?:-\d{4})?\s*$/);
  if (tail) return { city: tail[1].trim(), state: tail[2].toUpperCase(), zip: tail[3] };
  const zips = text.match(/\b\d{5}\b/g) || [];
  // A leading 5-digit number is a house number, not a ZIP code.
  const zip = zips.length > 0 && !new RegExp(`^\\s*${zips[zips.length - 1]}\\b`).test(text) ? zips[zips.length - 1] : "";
  return { city: "", state: "", zip };
}
