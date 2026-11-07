// Read-only access to the owner's Google Calendar, the single source of truth
// for bookings. Plain fetch, no Google client library. Never writes.
//
// Auth: a refresh token (scope calendar.readonly) is exchanged for an access
// token, which is kept in module scope until shortly before it expires. The
// refresh token stays in the environment and is never returned or logged.
import { SlotFinderError, missingEnv } from "../slotFinder/errors.js";
import { addDays, chicagoInstant, isValidDateString, toChicagoRfc3339 } from "../slotFinder/time.js";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const CALENDAR_URL = "https://www.googleapis.com/calendar/v3/calendars";
const REQUEST_TIMEOUT_MS = 8000;
const REFRESH_EARLY_MS = 60 * 1000;
const MAX_PAGES = 20;
// Only what the Slot Finder reads, so attendee lists and descriptions never leave Google.
const EVENT_FIELDS = "nextPageToken,items(status,summary,location,start,end,transparency,attendees(self,responseStatus))";

const CALENDAR_FAILED = "Google Calendar request failed.";
const SIGN_IN_EXPIRED =
  "Google Calendar request failed. The saved Google sign-in has expired or was revoked, so a new refresh token is needed.";

let tokenCache = null;

export function clearCalendarTokenCache() {
  tokenCache = null;
}

function requireEnv(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw missingEnv(name);
  return value;
}

async function fetchWithTimeout(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    throw new SlotFinderError(CALENDAR_FAILED, 502);
  } finally {
    clearTimeout(timer);
  }
}

async function getAccessToken() {
  const clientId = requireEnv("GOOGLE_CALENDAR_CLIENT_ID");
  const clientSecret = requireEnv("GOOGLE_CALENDAR_CLIENT_SECRET");
  const refreshToken = requireEnv("GOOGLE_CALENDAR_REFRESH_TOKEN");

  if (tokenCache && tokenCache.refreshToken === refreshToken && tokenCache.expiresAt - REFRESH_EARLY_MS > Date.now()) {
    return tokenCache.accessToken;
  }

  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    }).toString()
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || !data?.access_token) {
    tokenCache = null;
    throw new SlotFinderError(data?.error === "invalid_grant" ? SIGN_IN_EXPIRED : CALENDAR_FAILED, 502);
  }

  const lifetimeSeconds = Number(data.expires_in) > 0 ? Number(data.expires_in) : 3600;
  tokenCache = { accessToken: data.access_token, expiresAt: Date.now() + lifetimeSeconds * 1000, refreshToken };
  return data.access_token;
}

// 00:00 to 24:00 Chicago on the date, with the offset each end actually has
// (they differ on a daylight saving day).
export function dayWindow(date) {
  return {
    timeMin: toChicagoRfc3339(chicagoInstant(date)),
    timeMax: toChicagoRfc3339(chicagoInstant(addDays(date, 1)))
  };
}

// Every event that overlaps the Chicago day, recurring ones expanded, as
// Google returns them.
export async function listDayEvents(date) {
  const calendarId = String(process.env.GOOGLE_CALENDAR_ID || "").trim() || "primary";
  const accessToken = await getAccessToken();
  const { timeMin, timeMax } = dayWindow(date);
  const items = [];
  let pageToken = "";

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const params = new URLSearchParams({
      singleEvents: "true",
      orderBy: "startTime",
      timeMin,
      timeMax,
      maxResults: "250",
      fields: EVENT_FIELDS
    });
    if (pageToken) params.set("pageToken", pageToken);

    const response = await fetchWithTimeout(`${CALENDAR_URL}/${encodeURIComponent(calendarId)}/events?${params}`, {
      headers: { Authorization: `Bearer ${accessToken}` }
    });
    if (response.status === 401) tokenCache = null;
    if (!response.ok) throw new SlotFinderError(CALENDAR_FAILED, 502);

    const data = await response.json().catch(() => null);
    if (!data || typeof data !== "object") throw new SlotFinderError(CALENDAR_FAILED, 502);
    if (Array.isArray(data.items)) items.push(...data.items);
    pageToken = data.nextPageToken || "";
    if (!pageToken) return items;
  }
  return items;
}

function toInstant(point) {
  if (point?.dateTime) {
    const instant = new Date(point.dateTime);
    return Number.isNaN(instant.getTime()) ? null : instant;
  }
  // All-day: a date only. Read as Chicago midnight so no date-only value
  // reaches the time math.
  if (point?.date && isValidDateString(point.date)) return chicagoInstant(point.date);
  return null;
}

const declinedByOwner = (item) =>
  Array.isArray(item.attendees) && item.attendees.some((a) => a?.self === true && a.responseStatus === "declined");

// The events that block time: not cancelled, not "Show as free", not declined.
// A busy all-day event becomes a block from 00:00 to 24:00 Chicago on each of
// its days. Sorted by start time.
export function normalizeEvents(items) {
  const events = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== "object") continue;
    if (item.status === "cancelled") continue;
    if (item.transparency === "transparent") continue;
    if (declinedByOwner(item)) continue;

    const allDay = Boolean(item.start?.date) && !item.start?.dateTime;
    const start = toInstant(item.start);
    if (!start) continue;
    let end = toInstant(item.end);
    if (!end || end < start) end = allDay ? chicagoInstant(addDays(item.start.date, 1)) : start;

    events.push({
      summary: String(item.summary || "").trim(),
      start,
      end,
      location: String(item.location || "").trim(),
      status: item.status || "confirmed",
      allDay
    });
  }
  return events.sort((a, b) => a.start - b.start || a.end - b.end);
}
