import mongoose from "mongoose";
import { Appointment } from "../models/Appointment.js";
import { AppointmentSettings } from "../models/AppointmentSettings.js";
import { sendAppointmentConfirmation } from "../services/emailService.js";
import { asyncHandler } from "../utils.js";

const APPOINTMENT_STATUSES = ["requested", "confirmed", "cancelled", "completed"];
const ACTIVE_STATUSES = ["requested", "confirmed"];
const DEFAULT_SLOT_MINUTES = 120;
const DEFAULT_WEEKLY_AVAILABILITY = [
  { day: 0, enabled: false, startTime: "10:00", endTime: "17:00" },
  { day: 1, enabled: true, startTime: "10:00", endTime: "17:00" },
  { day: 2, enabled: true, startTime: "10:00", endTime: "17:00" },
  { day: 3, enabled: true, startTime: "10:00", endTime: "17:00" },
  { day: 4, enabled: true, startTime: "10:00", endTime: "17:00" },
  { day: 5, enabled: true, startTime: "10:00", endTime: "17:00" },
  { day: 6, enabled: false, startTime: "10:00", endTime: "15:00" }
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

function normalizeAvailability(input) {
  const byDay = new Map(DEFAULT_WEEKLY_AVAILABILITY.map((item) => [item.day, { ...item }]));
  if (Array.isArray(input)) {
    input.forEach((raw) => {
      const day = Number(raw?.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) return;
      const startTime = String(raw?.startTime || "").trim();
      const endTime = String(raw?.endTime || "").trim();
      const start = parseTime(startTime);
      const end = parseTime(endTime);
      byDay.set(day, {
        day,
        enabled: Boolean(raw?.enabled),
        startTime: start !== null ? startTime : "10:00",
        endTime: end !== null && start !== null && end > start ? endTime : "17:00"
      });
    });
  }
  return Array.from(byDay.values()).sort((a, b) => a.day - b.day);
}

function normalizeBlocks(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map((raw) => {
      const date = String(raw?.date || "").trim();
      const reason = String(raw?.reason || "").trim();
      const startTime = String(raw?.startTime || "").trim();
      const endTime = String(raw?.endTime || "").trim();
      const hasTimeRange = Boolean(startTime || endTime);
      if (!hasTimeRange) return { date, startTime: "", endTime: "", reason };

      const start = parseTime(startTime);
      const end = parseTime(endTime);
      if (start === null || end === null || end <= start) return null;
      return { date, startTime, endTime, reason };
    })
    .filter((block) => block && /^\d{4}-\d{2}-\d{2}$/.test(block.date))
    .slice(0, 120);
}

function getBlockIntervals(settings, date) {
  return normalizeBlocks(settings.dayBlocks)
    .filter((block) => block.date === date)
    .map((block) => {
      const start = block.startTime ? parseTime(block.startTime) : 0;
      const end = block.endTime ? parseTime(block.endTime) : 24 * 60;
      if (start === null || end === null || end <= start) return null;
      return { start, end };
    })
    .filter(Boolean);
}

function overlapsBlock(start, end, blocks) {
  return blocks.some((block) => start < block.end && end > block.start);
}

function serializeSettings(settings) {
  return {
    slotMinutes: settings.slotMinutes,
    bookingHorizonDays: settings.bookingHorizonDays,
    weeklyAvailability: normalizeAvailability(settings.weeklyAvailability),
    dayBlocks: normalizeBlocks(settings.dayBlocks)
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
    dayBlocks: []
  });
}

async function getSlots(settings, fromDate, days) {
  const weekly = normalizeAvailability(settings.weeklyAvailability);
  const horizon = Math.min(Math.max(Number(days || settings.bookingHorizonDays || 14), 1), 31);
  const base = fromDate && /^\d{4}-\d{2}-\d{2}$/.test(fromDate)
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

  return dates.map((day) => {
    const date = new Date(`${day}T00:00:00.000Z`);
    const availability = weekly.find((item) => item.day === date.getUTCDay());
    if (!availability?.enabled) {
      return { date: day, slots: [] };
    }
    const blockIntervals = getBlockIntervals(settings, day);
    const startMinutes = parseTime(availability.startTime);
    const endMinutes = parseTime(availability.endTime);
    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
      return { date: day, slots: [] };
    }
    const slots = [];
    for (let minute = startMinutes; minute + slotMinutes <= endMinutes; minute += slotMinutes) {
      const startTime = formatTime(minute);
      if (!booked.has(`${day}:${startTime}`) && !overlapsBlock(minute, minute + slotMinutes, blockIntervals)) {
        slots.push({ startTime, endTime: formatTime(minute + slotMinutes) });
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
  const weekly = normalizeAvailability(settings.weeklyAvailability);
  const d = new Date(`${date}T00:00:00.000Z`);
  const availability = weekly.find((item) => item.day === d.getUTCDay());
  if (!availability?.enabled) return "That day is not available.";
  const start = parseTime(startTime);
  const windowStart = parseTime(availability.startTime);
  const windowEnd = parseTime(availability.endTime);
  const slotMinutes = Math.min(Math.max(Number(settings.slotMinutes || DEFAULT_SLOT_MINUTES), 15), 240);
  if (start === null || windowStart === null || windowEnd === null) return "Invalid appointment time.";
  if (start < windowStart || start + slotMinutes > windowEnd) return "Appointment time is outside availability.";
  if ((start - windowStart) % slotMinutes !== 0) return "Appointment time does not match an open slot.";
  if (overlapsBlock(start, start + slotMinutes, getBlockIntervals(settings, date))) {
    return "That time is blocked.";
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
  settings.slotMinutes = slotMinutes;
  settings.bookingHorizonDays = bookingHorizonDays;
  settings.weeklyAvailability = normalizeAvailability(
    hasOwn("weeklyAvailability") ? req.body.weeklyAvailability : settings.weeklyAvailability
  );
  settings.dayBlocks = normalizeBlocks(hasOwn("dayBlocks") ? req.body.dayBlocks : settings.dayBlocks);
  await settings.save();
  res.json(serializeSettings(settings));
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
