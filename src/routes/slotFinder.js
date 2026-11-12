import { Router } from "express";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { requireAuth } from "../middleware/auth.js";
import { SlotFinderError, missingEnv } from "../slotFinder/errors.js";
import { searchDays } from "../slotFinder/service.js";
import { listBookedJobEvents } from "../slotFinder/bookedJobs.js";
import {
  DEFAULT_DURATION,
  MAX_DURATION,
  MIN_DURATION,
  getSlotFinderSettings,
  updateSlotFinderSettings
} from "../slotFinder/settings.js";
import { chicagoDateString, isValidDateString } from "../slotFinder/time.js";

// The pasted address is used for this one request only: never saved, never
// logged (app.js keeps this path's query string out of the access log, and the
// dashboard and MCP tool send it in a POST body so it is not in any URL).
const router = Router();
const MAX_ADDRESS_LENGTH = 300;

router.use(requireAuth);
// Every search is a few paid Google Routes calls; this caps a runaway client.
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => String(req.accountId || ipKeyGenerator(req.ip || "unknown")),
    message: { error: "Too many slot searches. Wait a moment and try again.", message: "Too many slot searches. Wait a moment and try again." }
  })
);

// `error` is the Slot Finder contract; `message` is what the dashboard and
// MCP server read from every other route.
function sendError(res, status, message) {
  return res.status(status).json({ error: message, message });
}

function handleError(res, error) {
  if (error instanceof SlotFinderError) return sendError(res, error.status, error.message);
  // No request details here: they would include the customer's address.
  console.error("Slot Finder failed:", error?.stack || error);
  return sendError(res, 500, "Internal server error.");
}

// The calendar behind GOOGLE_CALENDAR_* belongs to one business. Other accounts
// on this deployment must not see its bookings.
function assertCalendarOwner(req) {
  const owner = String(process.env.GOOGLE_CALENDAR_ACCOUNT_ID || "").trim();
  if (!owner) throw missingEnv("GOOGLE_CALENDAR_ACCOUNT_ID");
  if (owner !== String(req.accountId)) {
    throw new SlotFinderError("Slot Finder reads the business owner's Google Calendar and is not available on this account.", 403);
  }
}

const single = (value) => (Array.isArray(value) ? value[0] : value);

function parseDuration(raw) {
  const value = single(raw);
  if (value === undefined || value === null || value === "") return null;
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  const minutes = /^\d+$/.test(text) ? Number(text) : NaN;
  if (!Number.isInteger(minutes) || minutes < MIN_DURATION || minutes > MAX_DURATION) {
    throw new SlotFinderError(`Duration must be a whole number of minutes from ${MIN_DURATION} to ${MAX_DURATION}.`);
  }
  return minutes;
}

async function search(req, res, input) {
  try {
    assertCalendarOwner(req);

    const rawAddress = single(input.address);
    const address = typeof rawAddress === "string" ? rawAddress.trim().replace(/\s+/g, " ") : "";
    if (!address) throw new SlotFinderError("Address is required.");
    if (address.length > MAX_ADDRESS_LENGTH) throw new SlotFinderError(`Address is too long (${MAX_ADDRESS_LENGTH} characters at most).`);

    const rawDate = single(input.date);
    let date = chicagoDateString(new Date());
    if (rawDate !== undefined && rawDate !== null && rawDate !== "") {
      if (!isValidDateString(rawDate)) throw new SlotFinderError("Date must be a real date in YYYY-MM-DD format.");
      date = rawDate;
    }

    let durationMinutes = parseDuration(input.duration);
    const settings = await getSlotFinderSettings(req.accountId);
    if (durationMinutes === null) {
      const service = single(input.service);
      if (service !== undefined && service !== null && service !== "") {
        durationMinutes = settings.serviceDurations[service];
        if (!Object.prototype.hasOwnProperty.call(settings.serviceDurations, service)) {
          throw new SlotFinderError(`Unknown service. Use one of: ${Object.keys(settings.serviceDurations).join(", ")}.`);
        }
      } else {
        durationMinutes = DEFAULT_DURATION;
      }
    }

    const rawDays = single(input.days);
    let days = 1;
    if (rawDays !== undefined && rawDays !== null && rawDays !== "") {
      days = Number(rawDays);
      if (!Number.isInteger(days) || days < 1 || days > 3) throw new SlotFinderError("days must be 1, 2 or 3.");
    }

    res.set("Cache-Control", "no-store");
    return res.json(
      await searchDays(
        { date, days, address, durationMinutes, settings },
        { fetchBookedJobs: (day) => listBookedJobEvents(req.accountId, day) }
      )
    );
  } catch (error) {
    return handleError(res, error);
  }
}

// GET /api/slot-finder?date=YYYY-MM-DD&address=...&duration=60[&service=...]
router.get("/", (req, res) => search(req, res, req.query));

// POST /api/slot-finder { date, address, duration, service } — the same search
// with the address in the body, so it stays out of URLs and request logs.
router.post("/", (req, res) => search(req, res, req.body ?? {}));

// GET /api/slot-finder/settings — slot grid, services, buffer, home base, templates.
router.get("/settings", async (req, res) => {
  try {
    res.json(await getSlotFinderSettings(req.accountId));
  } catch (error) {
    handleError(res, error);
  }
});

// PUT /api/slot-finder/settings — partial: fields left out keep their value.
router.put("/settings", async (req, res) => {
  try {
    res.json(await updateSlotFinderSettings(req.accountId, req.body ?? {}));
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
