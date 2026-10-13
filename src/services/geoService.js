// Address lookup for records, so jobs can be grouped by area.
//
// Two free services, neither needing a key:
//  - The US Census geocoder turns a full address into its exact ZIP code and
//    coordinates. It is fast and dependable, and it is what the area numbers
//    are built on.
//  - Photon (OpenStreetMap) completes street names as the owner types. Its
//    public server is throttled and its house numbers and ZIP codes are patchy
//    in Houston, so it is only a typing aid: nothing depends on it answering.
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

// Where the business works. Suggestions lean towards the center and stay inside
// the box, and an address typed without a city is tried in the default one.
// Defaults to Houston and the area around it.
export function geoConfig() {
  const lat = Number(process.env.GEO_CENTER_LAT);
  const lon = Number(process.env.GEO_CENTER_LON);
  return {
    lat: Number.isFinite(lat) && lat !== 0 ? lat : 29.7604,
    lon: Number.isFinite(lon) && lon !== 0 ? lon : -95.3698,
    bbox: process.env.GEO_BBOX || "-96.4,29.0,-94.6,30.6",
    defaultCity: process.env.GEO_DEFAULT_CITY || "Houston, TX"
  };
}

async function getJson(url, timeoutMs, { retries = 0 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let attempt = 0; ; attempt += 1) {
      const response = await fetch(url, {
        headers: { Accept: "application/json", "User-Agent": USER_AGENT },
        signal: controller.signal
      });
      if (response.ok) return await response.json();
      // A throttled server usually answers the very next request.
      if (attempt >= retries || response.status < 500) return null;
      await new Promise((resolve) => setTimeout(resolve, 350));
    }
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

// "11822 Bandlon Dr" -> ["11822", "Bandlon Dr"]. Photon mostly knows streets,
// not houses, so it is asked for the street and the number is put back after.
function splitHouseNumber(text) {
  const match = String(text).match(/^(\d+[A-Za-z]?)\s+(.*)$/);
  return match ? [match[1], match[2]] : ["", String(text)];
}

// One Photon result as a street suggestion, or null when it is not a street a
// job could be on (a park with no street, a result outside the US).
function toStreetSuggestion(feature, houseNumber) {
  const p = feature?.properties || {};
  const [lng, lat] = feature?.geometry?.coordinates || [];
  if (p.countrycode && String(p.countrycode).toUpperCase() !== "US") return null;

  const street = p.street || (p.type === "street" ? p.name : "");
  if (!street) return null;

  const city = p.city || "";
  const state = stateCode(p.state);
  const line1 = [houseNumber, street].filter(Boolean).join(" ");
  // No ZIP: a street match can sit in any of the ZIP codes a long road crosses.
  // The exact address is looked up once it is picked.
  const line2 = [city, state].filter(Boolean).join(", ");
  return {
    label: [line1, line2].filter(Boolean).join(", "),
    line1,
    line2,
    city,
    state,
    zip: "",
    neighborhood: [p.locality, p.district].find((name) => name && name !== city) || "",
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null,
    verified: false
  };
}

async function streetSuggestions(text) {
  const [houseNumber, street] = splitHouseNumber(text);
  if (street.trim().length < 3) return [];

  const { lat, lon, bbox } = geoConfig();
  const params = new URLSearchParams({ q: street.trim(), lat: String(lat), lon: String(lon), limit: "10", lang: "en", bbox });
  const data = await getJson(`${PHOTON_URL}/api/?${params}`, 4000, { retries: 1 });

  const seen = new Set();
  const suggestions = [];
  for (const feature of data?.features || []) {
    const suggestion = toStreetSuggestion(feature, houseNumber);
    if (!suggestion) continue;
    // One line per street and city: the stretches of a long road look the same.
    const key = suggestion.label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    suggestions.push(suggestion);
  }
  return suggestions;
}

async function censusMatch(text) {
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
  const line2 = [city, [state, zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  return {
    address: [line1, line2].filter(Boolean).join(", "),
    line1,
    line2,
    city,
    state,
    zip,
    lat: Number.isFinite(lat) ? lat : null,
    lng: Number.isFinite(lng) ? lng : null
  };
}

/**
 * The exact ZIP code, city and coordinates of an address, or null when it
 * cannot be placed (too little to go on, no such address, or the lookup is
 * down). An address typed with no city or ZIP is tried in the default city.
 */
export async function resolveAddress(address) {
  const text = String(address || "").trim().replace(/\s+/g, " ");
  if (text.length < 6 || !/^\d/.test(text) || !/[A-Za-z]{2}/.test(text) || !lookupEnabled()) return null;

  return cached(`r:${text.toLowerCase()}`, async () => {
    const asTyped = await censusMatch(text);
    if (asTyped) return asTyped;
    const namesPlace = text.includes(",") || /\b\d{5}(-\d{4})?\s*$/.test(text);
    return namesPlace ? null : censusMatch(`${text}, ${geoConfig().defaultCity}`);
  });
}

/**
 * Streets that what has been typed so far could be, with the typed house number
 * kept in front. A typing aid only: the public server is slow and throttled, so
 * the form asks for the exact address (resolveAddress) alongside and never waits
 * on this. Never throws; [] when there is nothing to offer.
 */
export async function autocomplete(query) {
  const text = String(query || "").trim().replace(/\s+/g, " ");
  if (text.length < 4 || !lookupEnabled()) return [];

  const streets = await cached(`a:${text.toLowerCase()}`, async () => {
    const found = await streetSuggestions(text);
    return found.length > 0 ? found : null;
  });
  return (streets || []).slice(0, 5);
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
