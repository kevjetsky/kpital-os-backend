// Online booking settings, from the environment. Slot rules (the grid, buffer,
// home base, "home by") are NOT here: they are the owner's Slot Finder settings,
// so the booking page and the Slot Finder always agree.

const DEFAULTS = {
  BOOKING_ENABLED: "false",
  BOOKING_WINDOW_DAYS: 7,
  BOOKING_JOB_MINUTES: 60,
  BOOKING_HOLD_MINUTES: 10,
  BOOKING_MIN_LEAD_MINUTES: 90,
  // The day's last grid slot only fits when the drive home is at most this.
  BOOKING_LAST_SLOT_MAX_DRIVE_HOME_MIN: 20,
  // The service area: at most this many minutes' drive from home base.
  BOOKING_MAX_DRIVE_MIN: 45,
  // Paid Google Routes elements the booking page may spend a day. It shares the
  // project's daily Routes limit with the Slot Finder, so it stays well under it.
  BOOKING_MAPS_DAILY_CAP: 500,
  BOOKING_MAX_ACTIVE_PER_PHONE: 2,
  BOOKING_MAX_PER_ADDRESS_PER_DAY: 1,
  BOOKING_EVENT_COLOR_ID: "9",
  BOOKING_EMAIL_SUBJECT_PREFIX: "",
  BOOKING_BUSINESS_PHONE: "+13466674364",
  BOOKING_ALLOWED_ORIGINS: "https://we-fix-consoles.com,https://www.we-fix-consoles.com",
  BOOKING_ALLOWED_ORIGIN_SUFFIXES: "",
  BOOKING_RATE_CHECK_AREA_PER_HOUR: 10,
  BOOKING_RATE_SUGGEST_PER_HOUR: 150,
  BOOKING_RATE_SLOTS_PER_HOUR: 30,
  BOOKING_RATE_HOLD_PER_HOUR: 10,
  BOOKING_RATE_BOOK_PER_DAY: 3
};

const text = (value, fallback) => {
  const trimmed = String(value ?? "").trim();
  return trimmed || fallback;
};
const number = (value, fallback) => {
  const parsed = Number(String(value ?? "").trim());
  return String(value ?? "").trim() !== "" && Number.isFinite(parsed) ? parsed : fallback;
};
const list = (value) =>
  String(value ?? "")
    .split(",")
    .map((item) => item.trim().replace(/\/+$/, ""))
    .filter(Boolean);

function parseServiceArea(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    console.warn(JSON.stringify({ event: "booking_config", warning: "BOOKING_SERVICE_AREA_GEOJSON is not valid JSON; ignored" }));
    return null;
  }
}

export function loadBookingConfig(env = process.env) {
  const get = (name) => (env[name] === undefined ? DEFAULTS[name] : env[name]);
  return {
    enabled: String(get("BOOKING_ENABLED")).toLowerCase() === "true",
    windowDays: Math.max(1, Math.min(14, number(get("BOOKING_WINDOW_DAYS"), DEFAULTS.BOOKING_WINDOW_DAYS))),
    jobMinutes: number(get("BOOKING_JOB_MINUTES"), DEFAULTS.BOOKING_JOB_MINUTES),
    holdMinutes: number(get("BOOKING_HOLD_MINUTES"), DEFAULTS.BOOKING_HOLD_MINUTES),
    minLeadMinutes: number(get("BOOKING_MIN_LEAD_MINUTES"), DEFAULTS.BOOKING_MIN_LEAD_MINUTES),
    lastSlotMaxDriveHomeMin: number(get("BOOKING_LAST_SLOT_MAX_DRIVE_HOME_MIN"), DEFAULTS.BOOKING_LAST_SLOT_MAX_DRIVE_HOME_MIN),
    maxDriveMin: number(get("BOOKING_MAX_DRIVE_MIN"), DEFAULTS.BOOKING_MAX_DRIVE_MIN),
    mapsDailyCap: number(get("BOOKING_MAPS_DAILY_CAP"), DEFAULTS.BOOKING_MAPS_DAILY_CAP),
    maxActivePerPhone: number(get("BOOKING_MAX_ACTIVE_PER_PHONE"), DEFAULTS.BOOKING_MAX_ACTIVE_PER_PHONE),
    maxPerAddressPerDay: number(get("BOOKING_MAX_PER_ADDRESS_PER_DAY"), DEFAULTS.BOOKING_MAX_PER_ADDRESS_PER_DAY),
    eventColorId: text(get("BOOKING_EVENT_COLOR_ID"), DEFAULTS.BOOKING_EVENT_COLOR_ID),
    emailSubjectPrefix: String(get("BOOKING_EMAIL_SUBJECT_PREFIX") ?? ""),
    businessPhone: text(get("BOOKING_BUSINESS_PHONE"), DEFAULTS.BOOKING_BUSINESS_PHONE),
    allowedOrigins: list(get("BOOKING_ALLOWED_ORIGINS")),
    allowedOriginSuffixes: list(get("BOOKING_ALLOWED_ORIGIN_SUFFIXES")),
    serviceArea: parseServiceArea(env.BOOKING_SERVICE_AREA_GEOJSON),
    // The business whose calendar, jobs and settings the booking page uses.
    ownerAccountId: text(env.GOOGLE_CALENDAR_ACCOUNT_ID, ""),
    calendarId: text(env.BOOKING_CALENDAR_ID, text(env.GOOGLE_CALENDAR_ID, "primary")),
    areaTokenSecret: text(env.BOOKING_AREA_TOKEN_SECRET, ""),
    turnstileSecret: text(env.BOOKING_TURNSTILE_SECRET, ""),
    rates: {
      checkArea: { limit: number(get("BOOKING_RATE_CHECK_AREA_PER_HOUR"), DEFAULTS.BOOKING_RATE_CHECK_AREA_PER_HOUR), windowSec: 3600 },
      suggest: { limit: number(get("BOOKING_RATE_SUGGEST_PER_HOUR"), DEFAULTS.BOOKING_RATE_SUGGEST_PER_HOUR), windowSec: 3600 },
      slots: { limit: number(get("BOOKING_RATE_SLOTS_PER_HOUR"), DEFAULTS.BOOKING_RATE_SLOTS_PER_HOUR), windowSec: 3600 },
      hold: { limit: number(get("BOOKING_RATE_HOLD_PER_HOUR"), DEFAULTS.BOOKING_RATE_HOLD_PER_HOUR), windowSec: 3600 },
      book: { limit: number(get("BOOKING_RATE_BOOK_PER_DAY"), DEFAULTS.BOOKING_RATE_BOOK_PER_DAY), windowSec: 86400 }
    }
  };
}

const configured = (...names) => names.every((name) => String(process.env[name] || "").trim());

export const calendarConfigured = () => configured("GOOGLE_CALENDAR_CLIENT_ID", "GOOGLE_CALENDAR_CLIENT_SECRET", "GOOGLE_CALENDAR_REFRESH_TOKEN");
export const routesConfigured = () => configured("GOOGLE_MAPS_API_KEY");
