// Slot Finder settings, kept on the account's Settings document (collection
// `settings`, field `slotFinder`) so the owner can change them without a code
// change. The defaults are written the first time an account uses the feature.
import { Settings } from "../models/Settings.js";
import { SlotFinderError } from "./errors.js";
import { isValidTimeString } from "./time.js";

const DEFAULTS = {
  slotStarts: ["09:00", "11:00", "13:00", "15:00", "17:00", "19:00", "21:00"],
  serviceDurations: {
    "HDMI repair": 60,
    Cleaning: 60,
    "Thermal paste": 60,
    "Controller repair": 45,
    Other: 60
  },
  bufferMinutes: 10,
  // The latest the owner wants to be back home after the day's last job, as
  // "HH:MM". Empty means no limit.
  homeBy: "",
  // A drive from home base longer than this is flagged, so a travel fee can be
  // quoted. 0 switches the flag off.
  farDriveMinutes: 45,
  homeBase: "11822 Bandlon Dr, Houston, TX 77072",
  messageTemplates: {
    enMany: "Hi, thanks for reaching out. For {dayLabel} I have availability at {slots}. Which one works best for you? Once you pick, I will confirm the booking.",
    enOne: "Hi, thanks for reaching out. For {dayLabel} I have availability at {slot}. Does that time work for you? Once you confirm, I will book it.",
    esMany: "Hola, gracias por escribir. Para {día} tengo disponibilidad a las {slots}. ¿Cuál le funciona mejor? Al elegir, le confirmo la cita.",
    esOne: "Hola, gracias por escribir. Para {día} tengo disponibilidad a las {slot}. ¿Le funciona esa hora? Al confirmar, le agendo la cita."
  }
};

export const TEMPLATE_KEYS = ["enMany", "enOne", "esMany", "esOne"];
export const MIN_DURATION = 15;
export const MAX_DURATION = 240;
export const DEFAULT_DURATION = 60;
const MAX_SLOTS = 24;
const MAX_SERVICES = 30;
const MAX_SERVICE_NAME = 60;
const MAX_BUFFER = 120;
const MAX_FAR_DRIVE = 240;
const MAX_HOME_BASE = 240;
const MAX_TEMPLATE = 1000;

export function defaultSlotFinderSettings() {
  return structuredClone(DEFAULTS);
}

const isWholeNumberIn = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// Mongo field names cannot hold "." or start with "$".
const isServiceName = (name) =>
  typeof name === "string" && name.trim() === name && name.length > 0 && name.length <= MAX_SERVICE_NAME && !name.includes(".") && !name.startsWith("$");

function cleanSlotStarts(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SLOTS) return null;
  if (!value.every(isValidTimeString)) return null;
  return [...new Set(value)].sort();
}

function cleanServiceDurations(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.length > MAX_SERVICES) return null;
  if (!entries.every(([name, minutes]) => isServiceName(name) && isWholeNumberIn(minutes, MIN_DURATION, MAX_DURATION))) return null;
  return Object.fromEntries(entries);
}

const cleanBuffer = (value) => (isWholeNumberIn(value, 0, MAX_BUFFER) ? value : null);
const cleanFarDrive = (value) => (isWholeNumberIn(value, 0, MAX_FAR_DRIVE) ? value : null);
// "" (no limit) or a time of day.
const cleanHomeBy = (value) => (value === "" || isValidTimeString(value) ? value : null);

function cleanHomeBase(value) {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  return text && text.length <= MAX_HOME_BASE ? text : null;
}

const cleanTemplate = (value) => (typeof value === "string" && value.trim() && value.length <= MAX_TEMPLATE ? value : null);

// Stored values over the defaults; anything missing or malformed falls back to
// its default, so a hand edit in the database cannot break the feature.
export function mergeWithDefaults(stored = {}) {
  const defaults = defaultSlotFinderSettings();
  const templates = { ...defaults.messageTemplates };
  for (const key of TEMPLATE_KEYS) {
    const value = cleanTemplate(stored?.messageTemplates?.[key]);
    if (value) templates[key] = value;
  }
  return {
    slotStarts: cleanSlotStarts(stored?.slotStarts) || defaults.slotStarts,
    serviceDurations: cleanServiceDurations(stored?.serviceDurations) || defaults.serviceDurations,
    bufferMinutes: cleanBuffer(stored?.bufferMinutes) ?? defaults.bufferMinutes,
    homeBy: cleanHomeBy(stored?.homeBy) ?? defaults.homeBy,
    farDriveMinutes: cleanFarDrive(stored?.farDriveMinutes) ?? defaults.farDriveMinutes,
    homeBase: cleanHomeBase(stored?.homeBase) || defaults.homeBase,
    messageTemplates: templates
  };
}

export async function getSlotFinderSettings(accountId) {
  const account = await Settings.findById(accountId).select("slotFinder").lean();
  if (!account) throw new SlotFinderError("Account not found.", 404);
  if (account.slotFinder && typeof account.slotFinder === "object") return mergeWithDefaults(account.slotFinder);

  const seeded = defaultSlotFinderSettings();
  // Only written when still absent, so two first requests cannot overwrite an edit.
  await Settings.updateOne({ _id: accountId, slotFinder: { $exists: false } }, { $set: { slotFinder: seeded } });
  return seeded;
}

// Partial update: fields left out keep their value. Each field is checked and
// a bad one is refused with a plain message rather than silently dropped.
export async function updateSlotFinderSettings(accountId, body = {}) {
  const current = await getSlotFinderSettings(accountId);
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key);
  const next = structuredClone(current);

  if (has("slotStarts")) {
    const value = cleanSlotStarts(body.slotStarts);
    if (!value) throw new SlotFinderError(`slotStarts must be a list of 1 to ${MAX_SLOTS} times like "09:00".`);
    next.slotStarts = value;
  }
  if (has("serviceDurations")) {
    const value = cleanServiceDurations(body.serviceDurations);
    if (!value) {
      throw new SlotFinderError(
        `serviceDurations must map each service name to a whole number of minutes from ${MIN_DURATION} to ${MAX_DURATION}.`
      );
    }
    next.serviceDurations = value;
  }
  if (has("bufferMinutes")) {
    const value = cleanBuffer(body.bufferMinutes);
    if (value === null) throw new SlotFinderError(`bufferMinutes must be a whole number from 0 to ${MAX_BUFFER}.`);
    next.bufferMinutes = value;
  }
  if (has("homeBy")) {
    const value = cleanHomeBy(body.homeBy);
    if (value === null) throw new SlotFinderError('homeBy must be a time like "22:30", or empty for no limit.');
    next.homeBy = value;
  }
  if (has("farDriveMinutes")) {
    const value = cleanFarDrive(body.farDriveMinutes);
    if (value === null) throw new SlotFinderError(`farDriveMinutes must be a whole number from 0 to ${MAX_FAR_DRIVE}.`);
    next.farDriveMinutes = value;
  }
  if (has("homeBase")) {
    const value = cleanHomeBase(body.homeBase);
    if (!value) throw new SlotFinderError(`homeBase must be an address of at most ${MAX_HOME_BASE} characters.`);
    next.homeBase = value;
  }
  if (has("messageTemplates")) {
    const templates = body.messageTemplates;
    if (!templates || typeof templates !== "object" || Array.isArray(templates)) {
      throw new SlotFinderError(`messageTemplates must be an object with any of: ${TEMPLATE_KEYS.join(", ")}.`);
    }
    for (const key of TEMPLATE_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(templates, key)) continue;
      const value = cleanTemplate(templates[key]);
      if (!value) throw new SlotFinderError(`messageTemplates.${key} must be text of at most ${MAX_TEMPLATE} characters.`);
      next.messageTemplates[key] = value;
    }
  }

  await Settings.updateOne({ _id: accountId }, { $set: { slotFinder: next } });
  return next;
}
