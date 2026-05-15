import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.js";
import { AppointmentSettings } from "../models/AppointmentSettings.js";
import { sendAppointmentConfirmation } from "../services/emailService.js";
import { asyncHandler } from "../utils.js";

const APPOINTMENT_STATUSES = ["requested", "confirmed", "cancelled", "completed"];
const ACTIVE_STATUSES = ["requested", "confirmed"];
const DEFAULT_SLOT_MINUTES = 120;
const DEFAULT_WEEKLY_AVAILABILITY = [
  { day: 0, blocks: [] },
  { day: 1, blocks: [{ startTime: "10:00", endTime: "17:00", status: "open" }] },
  { day: 2, blocks: [{ startTime: "10:00", endTime: "17:00", status: "open" }] },
  { day: 3, blocks: [{ startTime: "10:00", endTime: "17:00", status: "open" }] },
  { day: 4, blocks: [{ startTime: "10:00", endTime: "17:00", status: "open" }] },
  { day: 5, blocks: [{ startTime: "10:00", endTime: "17:00", status: "open" }] },
  { day: 6, blocks: [] }
];

function dateKey(date) {
  return date.toISOString().slice(0, 10);
}

function parseTime(value) {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function formatTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function addDays(base, offset) {
  const next = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  next.setUTCDate(next.getUTCDate() + offset);
  return next;
}

// Normalize an array of { startTime, endTime, status } blocks, dropping invalid entries.
function normalizeBlocks(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw) => {
      const startTime = String(raw?.startTime || "").trim();
      const endTime = String(raw?.endTime || "").trim();
      const status = raw?.status === "blocked" ? "blocked" : "open";
      const start = parseTime(startTime);
      const end = parseTime(endTime);
      if (start === null || end === null || end <= start) return null;
      return { startTime, endTime, status };
    })
    .filter(Boolean);
}

function normalizeAvailability(input) {
  const byDay = new Map(
    DEFAULT_WEEKLY_AVAILABILITY.map((item) => [item.day, { day: item.day, blocks: [...item.blocks] }])
  );
  if (Array.isArray(input)) {
    input.forEach((raw) => {
      const day = Number(raw?.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) return;
      byDay.set(day, { day, blocks: normalizeBlocks(raw?.blocks) });
    });
  }
  return Array.from(byDay.values()).sort((a, b) => a.day - b.day);
}

function normalizeDayOverrides(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw) => {
      const date = String(raw?.date || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      const blocks = normalizeBlocks(raw?.blocks);
      const reason = String(raw?.reason || "").trim();
      return { date, blocks, reason };
    })
    .filter(Boolean)
    .slice(0, 120);
}

// Returns the list of open intervals ({ start, end } in minutes) for a given date,
// using the day override if one exists, otherwise falling back to the weekly template.
function getOpenIntervals(settings, date) {
  const overrides = normalizeDayOverrides(settings.dayOverrides);
  const override = overrides.find((o) => o.date === date);

  let blocks;
  if (override) {
    blocks = override.blocks;
  } else {
    const d = new Date(`${date}T00:00:00.000Z`);
    const weekly = normalizeAvailability(settings.weeklyAvailability);
    const dayEntry = weekly.find((item) => item.day === d.getUTCDay());
    blocks = dayEntry?.blocks ?? [];
  }

  return blocks
    .filter((block) => block.status === "open")
    .map((block) => {
      const start = parseTime(block.startTime);
      const end = parseTime(block.endTime);
      if (start === null || end === null || end <= start) return null;
      return { start, end };
    })
    .filter(Boolean);
}

function serializeSettings(settings) {
  return {
    slotMinutes: settings.slotMinutes,
    bookingHorizonDays: settings.bookingHorizonDays,
    weeklyAvailability: normalizeAvailability(settings.weeklyAvailability),
    dayOverrides: normalizeDayOverrides(settings.dayOverrides)
  };
}

async function getSettingsDocument() {
  const settings = await AppointmentSettings.findOne({ key: "main" });
  if (settings) return settings;
  return AppointmentSettings.create({
    key: "main",
    slotMinutes: DEFAULT_SLOT_MINUTES,
    bookingHorizonDays: 14,
    weeklyAvailability: DEFAULT_WEEKLY_AVAILABILITY,
    dayOverrides: []
  });
}

async function getSlots(settings, fromDate, days) {
  const horizon = Math.min(Math.max(Number(days || settings.bookingHorizonDays || 14), 1), 31);
  const base =
    fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate)
      ? new Date(`${fromDate}T00:00:00.000Z`)
      : new Date();
  const start = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()));
  const dates = Array.from({ length: horizon }, (_, index) => dateKey(addDays(start, index)));

  const appointments = await Appointment.find({
    appointmentDate: { $in: dates },
    status: { $in: ACTIVE_STATUSES }
  }).lean();
  const booked = new Set(appointments.map((item) => `${item.appointmentDate}:${item.startTime}`));
  const slotMinutes = Math.min(Math.max(Number(settings.slotMinutes || DEFAULT_SLOT_MINUTES), 15), 240);

  const nowUtc = new Date();
  const nowDate = dateKey(nowUtc);
  const nowMinutes = nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes();

  return dates.map((day) => {
    const openIntervals = getOpenIntervals(settings, day);
    const slots = [];
    for (const interval of openIntervals) {
      for (let minute = interval.start; minute + slotMinutes <= interval.end; minute += slotMinutes) {
        // Exclude slots that have already passed today
        if (day === nowDate && minute <= nowMinutes) continue;
        const startTime = formatTime(minute);
        if (!booked.has(`${day}:${startTime}`)) {
          slots.push({ startTime, endTime: formatTime(minute + slotMinutes) });
        }
      }
    }
    return { date: day, slots };
  });
}

function getRequiredString(body, field, label) {
  const value = String(body?.[field] || "").trim();
  return value ? { value } : { error: `${label} is required.` };
}

function validateAppointmentTime(date, startTime, settings) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Invalid appointment date.";
  const start = parseTime(startTime);
  if (start === null) return "Invalid appointment time.";
  const slotMinutes = Math.min(Math.max(Number(settings.slotMinutes || DEFAULT_SLOT_MINUTES), 15), 240);

  const openIntervals = getOpenIntervals(settings, date);
  if (openIntervals.length === 0) return "That day is not available.";

  const containingInterval = openIntervals.find(
    (interval) => start >= interval.start && start + slotMinutes <= interval.end
  );
  if (!containingInterval) return "Appointment time is outside availability.";

  if ((start - containingInterval.start) % slotMinutes !== 0) {
    return "Appointment time does not match an open slot.";
  }

  return null;
}

export const getSettings = asyncHandler(async (_req, res) => {
  const settings = await getSettingsDocument();
  res.json(serializeSettings(settings));
});

export const updateSettings = asyncHandler(async (req, res) => {
  const settings = await getSettingsDocument();
  const hasOwn = (field) => Object.prototype.hasOwnProperty.call(req.body || {}, field);
  const slotMinutes = Number(req.body?.slotMinutes ?? settings.slotMinutes);
  const bookingHorizonDays = Number(req.body?.bookingHorizonDays ?? settings.bookingHorizonDays);

  if (!Number.isInteger(slotMinutes) || slotMinutes < 15 || slotMinutes > 240) {
    return res.status(400).json({ message: "Slot length must be between 15 and 240 minutes." });
  }
  if (!Number.isInteger(bookingHorizonDays) || bookingHorizonDays < 1 || bookingHorizonDays > 31) {
    return res.status(400).json({ message: "Booking horizon must be between 1 and 31 days." });
  }

  const newOverrides = hasOwn("dayOverrides") ? normalizeDayOverrides(req.body.dayOverrides) : null;

  // Warn if new day overrides would leave active appointments outside any open block
  const warnings = [];
  if (newOverrides !== null) {
    const dates = newOverrides.map((o) => o.date);
    if (dates.length > 0) {
      const affected = await Appointment.find({
        appointmentDate: { $in: dates },
        status: { $in: ACTIVE_STATUSES }
      }).lean();

      for (const appt of affected) {
        const override = newOverrides.find((o) => o.date === appt.appointmentDate);
        if (!override) continue;
        const openIntervals = override.blocks
          .filter((b) => b.status === "open")
          .map((b) => ({ start: parseTime(b.startTime), end: parseTime(b.endTime) }))
          .filter((i) => i.start !== null && i.end !== null);
        const apptStart = parseTime(appt.startTime);
        const apptEnd = parseTime(appt.endTime);
        const covered = openIntervals.some((i) => apptStart >= i.start && apptEnd <= i.end);
        if (!covered) {
          warnings.push({
            appointmentId: String(appt._id),
            appointmentDate: appt.appointmentDate,
            startTime: appt.startTime,
            customerName: appt.customerName
          });
        }
      }
    }
  }

  settings.slotMinutes = slotMinutes;
  settings.bookingHorizonDays = bookingHorizonDays;
  settings.weeklyAvailability = normalizeAvailability(
    hasOwn("weeklyAvailability") ? req.body.weeklyAvailability : settings.weeklyAvailability
  );
  settings.dayOverrides = newOverrides !== null
    ? newOverrides
    : normalizeDayOverrides(settings.dayOverrides);
  await settings.save();

  const response = serializeSettings(settings);
  if (warnings.length > 0) response.warnings = warnings;
  res.json(response);
});

export const list = asyncHandler(async (req, res) => {
  const query = {};
  if (req.query?.status) {
    const status = String(req.query.status);
    if (!APPOINTMENT_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid appointment status." });
    }
    query.status = status;
  }
  const appointments = await Appointment.find(query)
    .sort({ appointmentDate: 1, startTime: 1, createdAt: -1 })
    .lean();
  res.json(appointments);
});

export const update = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid appointment id." });
  }
  const appointment = await Appointment.findById(id);
  if (!appointment) return res.status(404).json({ message: "Appointment not found." });
  const previousStatus = appointment.status;

  if (Object.prototype.hasOwnProperty.call(req.body || {}, "status")) {
    const status = String(req.body.status || "").trim();
    if (!APPOINTMENT_STATUSES.includes(status)) {
      return res.status(400).json({ message: "Invalid appointment status." });
    }
    appointment.status = status;
  }

  if (req.body?.appointmentDate || req.body?.startTime) {
    const settings = await getSettingsDocument();
    const appointmentDate = String(req.body?.appointmentDate || appointment.appointmentDate).trim();
    const startTime = String(req.body?.startTime || appointment.startTime).trim();
    const timeError = validateAppointmentTime(appointmentDate, startTime, settings);
    if (timeError) return res.status(400).json({ message: timeError });
    const slotMinutes = Math.min(Math.max(Number(settings.slotMinutes || DEFAULT_SLOT_MINUTES), 15), 240);
    const endTime = formatTime(parseTime(startTime) + slotMinutes);
    const conflict = await Appointment.findOne({
      _id: { $ne: id },
      appointmentDate,
      startTime,
      status: { $in: ACTIVE_STATUSES }
    });
    if (conflict) return res.status(409).json({ message: "That slot is already booked." });
    appointment.appointmentDate = appointmentDate;
    appointment.startTime = startTime;
    appointment.endTime = endTime;
  }

  if (Object.prototype.hasOwnProperty.call(req.body || {}, "notes")) {
    appointment.notes = String(req.body.notes || "").trim();
  }

  await appointment.save();

  let confirmationEmail = null;
  if (previousStatus !== "confirmed" && appointment.status === "confirmed") {
    try {
      confirmationEmail = await sendAppointmentConfirmation(appointment);
    } catch (err) {
      console.error("appointment confirmation email failed", err);
      confirmationEmail = { sent: false, error: "Failed to send confirmation email." };
    }
  }

  res.json({ ...appointment.toObject(), confirmationEmail });
});

export const getPublicAvailability = asyncHandler(async (req, res) => {
  const settings = await getSettingsDocument();
  const slots = await getSlots(settings, String(req.query?.from || ""), Number(req.query?.days));
  res.json({ settings: serializeSettings(settings), slots });
});

export const createPublicAppointment = asyncHandler(async (req, res) => {
  const settings = await getSettingsDocument();
  const appointmentDate = String(req.body?.appointmentDate || "").trim();
  const startTime = String(req.body?.startTime || "").trim();
  const timeError = validateAppointmentTime(appointmentDate, startTime, settings);
  if (timeError) return res.status(400).json({ message: timeError });

  const required = [
    ["customerName", "Name"],
    ["customerPhone", "Phone"],
    ["customerAddress", "Address"],
    ["deviceType", "Device"],
    ["issueDescription", "Issue details"]
  ].map(([field, label]) => [field, getRequiredString(req.body, field, label)]);
  const missing = required.find(([, result]) => result.error);
  if (missing) return res.status(400).json({ message: missing[1].error });

  const conflict = await Appointment.findOne({
    appointmentDate,
    startTime,
    status: { $in: ACTIVE_STATUSES }
  });
  if (conflict) return res.status(409).json({ message: "That slot was just booked. Please pick another time." });

  const slotMinutes = Math.min(Math.max(Number(settings.slotMinutes || DEFAULT_SLOT_MINUTES), 15), 240);
  const appointment = await Appointment.create({
    appointmentDate,
    startTime,
    endTime: formatTime(parseTime(startTime) + slotMinutes),
    customerName: required.find(([field]) => field === "customerName")[1].value,
    customerPhone: required.find(([field]) => field === "customerPhone")[1].value,
    customerAddress: required.find(([field]) => field === "customerAddress")[1].value,
    customerEmail: String(req.body?.customerEmail || "").trim(),
    deviceType: required.find(([field]) => field === "deviceType")[1].value,
    deviceModel: String(req.body?.deviceModel || "").trim(),
    issueDescription: required.find(([field]) => field === "issueDescription")[1].value,
    status: "requested"
  });
  res.status(201).json(appointment);
});
