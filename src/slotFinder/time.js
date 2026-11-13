// America/Chicago dates and times for the Slot Finder.
//
// Every availability decision is made on Chicago wall-clock time, never UTC or
// the server's own zone. Instants are plain Dates; these helpers convert between
// a Chicago calendar date plus "HH:MM" and the instant it names. The offset comes
// from Intl's time zone data, so daylight saving days (23 and 25 hours) work.

export const TIME_ZONE = "America/Chicago";

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TIME_ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit"
});

const pad = (value) => String(value).padStart(2, "0");

function chicagoParts(instant) {
  const parts = {};
  for (const { type, value } of partsFormatter.formatToParts(instant)) {
    if (type !== "literal") parts[type] = Number(value);
  }
  // Some ICU builds write midnight as hour 24 even under h23.
  if (parts.hour === 24) parts.hour = 0;
  return parts;
}

// Minutes Chicago is ahead of UTC at this instant: -360 (CST) or -300 (CDT).
function offsetMinutes(instant) {
  const p = chicagoParts(instant);
  const wallAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return Math.round((wallAsUtc - wholeSeconds) / 60000);
}

export function isValidDateString(value) {
  const match = DATE_PATTERN.exec(String(value ?? ""));
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidTimeString(value) {
  return TIME_PATTERN.test(String(value ?? ""));
}

// The instant a Chicago wall-clock time names on a Chicago calendar date.
export function chicagoInstant(dateString, time = "00:00") {
  const [year, month, day] = dateString.split("-").map(Number);
  const [hour, minute] = time.split(":").map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // First guess with the offset at the wall time read as UTC, then once more
  // with the offset at the guess, which settles it on either side of a change.
  const guess = wall - offsetMinutes(new Date(wall)) * 60000;
  return new Date(wall - offsetMinutes(new Date(guess)) * 60000);
}

// The Chicago calendar date (YYYY-MM-DD) an instant falls on.
export function chicagoDateString(instant) {
  const p = chicagoParts(instant);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function addDays(dateString, days) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

// 0 = Sunday. A calendar date's weekday does not depend on the time zone.
export function weekdayOf(dateString) {
  const [year, month, day] = dateString.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function addMinutes(instant, minutes) {
  return new Date(instant.getTime() + minutes * 60000);
}

// Built by hand rather than with Intl, which puts a narrow no-break space
// before AM/PM on newer ICU versions; a pasted message must read "9:00 PM".
function clock12(hour, minute) {
  const suffix = hour < 12 ? "AM" : "PM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${pad(minute)} ${suffix}`;
}

// "h:mm AM/PM" in Chicago time, e.g. "7:50 AM".
export function formatClock(instant) {
  const p = chicagoParts(instant);
  return clock12(p.hour, p.minute);
}

// "HH:MM", 24-hour, in Chicago time, e.g. "14:30".
export function chicagoTime(instant) {
  const p = chicagoParts(instant);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

// "21:00" -> "9:00 PM".
export function formatSlotTime(hhmm) {
  const [hour, minute] = hhmm.split(":").map(Number);
  return clock12(hour, minute);
}

// RFC 3339 with the Chicago offset in force at that instant,
// e.g. 2026-11-06T00:00:00-06:00.
export function toChicagoRfc3339(instant) {
  const p = chicagoParts(instant);
  const offset = offsetMinutes(instant);
  const sign = offset < 0 ? "-" : "+";
  const abs = Math.abs(offset);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}
