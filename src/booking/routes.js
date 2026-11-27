// Public online-booking API for the We-Fix-Consoles website, mounted at
// /api/public/booking before the app's own CORS (it answers other origins).
//
//   GET  /status       on/off and which parts are live
//   POST /suggest      address suggestions as the customer types
//   POST /check-area   is the address in the service area? -> areaToken
//   GET  /days         the days with a window that fits this address
//   GET  /slots        a day's windows
//   POST /hold         hold a window for 10 minutes
//   POST /release      let go of the customer's own hold
//   POST /book         book a held window (Idempotency-Key header)
//
// Errors answer { error: "<code>" } with the codes the booking page knows.
// Only the website origins may call it from a browser; Turnstile guards
// /check-area and /book; everything is rate limited per client address.
import express, { Router } from "express";
import { randomInt } from "node:crypto";
import { autocomplete, resolveAddress } from "../services/geoService.js";
import { deleteEvent, insertEvent } from "../services/googleCalendar.js";
import { isPushConfigured } from "../services/notificationService.js";
import { SlotFinderError } from "../slotFinder/errors.js";
import { getSlotFinderSettings } from "../slotFinder/settings.js";
import { addDays, addMinutes, chicagoDateString, chicagoInstant, chicagoTime, isValidDateString, toChicagoRfc3339 } from "../slotFinder/time.js";
import { addressKeyOf, pointInGeoJson, signAreaToken, verifyAreaToken } from "./area.js";
import { offeredByDate, publicSlots } from "./availability.js";
import { DEVICES, SERVICES } from "./catalog.js";
import { calendarConfigured, loadBookingConfig, routesConfigured } from "./config.js";
import { RoutesBudgetError, makeBookingDrive } from "./drive.js";
import { Booking, bookingIndexesReady } from "./models.js";
import { maskPhone, notifyBooking } from "./notify.js";
import {
  beginRequest,
  capReason,
  claimHold,
  countRequest,
  endRequest,
  getHold,
  markBooked,
  placeHold,
  releaseHold,
  releaseOwnHold
} from "./store.js";

const router = Router();

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const log = (event, fields = {}) => console.log(JSON.stringify({ event, ...fields }));

// ── CORS: the website origins only, no cookies ──

function allowedOrigin(origin, config) {
  const normalized = String(origin || "").replace(/\/+$/, "");
  if (config.allowedOrigins.includes(normalized)) return true;
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && config.allowedOriginSuffixes.some((suffix) => url.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

router.use((req, res, next) => {
  const config = loadBookingConfig();
  req.bookingConfig = config;
  res.set("Cache-Control", "no-store");
  res.set("X-Robots-Tag", "noindex");
  const origin = req.headers.origin;
  if (origin) {
    if (!allowedOrigin(origin, config)) return res.status(403).json({ error: "origin_not_allowed" });
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    res.set("Access-Control-Allow-Headers", "Content-Type, Idempotency-Key");
    res.set("Access-Control-Max-Age", "600");
    return res.status(204).end();
  }
  return next();
});

router.use(express.json({ limit: "16kb" }));

// ── helpers ──

const stripHtml = (value) =>
  String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/\s+/g, " ")
    .trim();
const stripHtmlKeepLines = (value) =>
  String(value ?? "")
    .replace(/<[^>]*>/g, "")
    .replace(/[<>]/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();

export function toE164(raw) {
  const digits = String(raw ?? "").replace(/\D/g, "");
  const national = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  if (national.length !== 10 || /^[01]/.test(national) || /^\d{3}[01]/.test(national)) return null;
  return `+1${national}`;
}

function bookingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return `WFC-${Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join("")}`;
}

// "1600 Smith Street" and "1600 Smith St" are the same line.
const STREET_WORDS = { street: "st", drive: "dr", avenue: "ave", road: "rd", boulevard: "blvd", lane: "ln", court: "ct", parkway: "pkwy", highway: "hwy", freeway: "fwy", place: "pl", circle: "cir", trail: "trl", north: "n", south: "s", east: "e", west: "w" };
export function sameStreetLine(a, b) {
  const norm = (text) =>
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => STREET_WORDS[word] || word)
      .join(" ");
  return norm(a) === norm(b);
}

async function verifyTurnstile(token, ip, config) {
  if (!config.turnstileSecret) {
    log("booking_turnstile_skipped", { reason: "BOOKING_TURNSTILE_SECRET not set" });
    return true;
  }
  if (typeof token !== "string" || !token || token.length > 4096) return false;
  const body = new URLSearchParams({ secret: config.turnstileSecret, response: token });
  if (ip) body.set("remoteip", ip);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
    const data = await response.json();
    return Boolean(data?.success);
  } catch {
    return false;
  }
}

async function rateLimit(ctx, bucket) {
  const rule = ctx.config.rates[bucket];
  const result = await countRequest({ bucket, subject: ctx.ip || "unknown", limit: rule.limit, windowSec: rule.windowSec }, ctx.now);
  if (!result.ok) {
    log("booking_rejected", { route: bucket, reason: "rate_limit" });
    throw new HttpError(429, "rate_limited", { retryAfterSec: result.retryAfterSec });
  }
}

function requireArea(ctx, token) {
  const area = verifyAreaToken(token, ctx.config.areaTokenSecret, { now: ctx.now.getTime() });
  if (!area) throw new HttpError(401, "area_token_invalid");
  return area;
}

const windowDates = (ctx) => {
  const today = chicagoDateString(ctx.now);
  return Array.from({ length: ctx.config.windowDays }, (_, i) => addDays(today, i));
};

async function offered(ctx, area, dates, { exceptHoldId = null } = {}) {
  return offeredByDate({
    dates,
    address: area.a,
    accountId: ctx.config.ownerAccountId,
    settings: ctx.settings,
    config: ctx.config,
    now: ctx.now,
    drive: ctx.drive,
    exceptHoldId,
    addressKey: area.k
  });
}

async function freshSlots(ctx, area, date) {
  try {
    return publicSlots((await offered(ctx, area, [date])).get(date));
  } catch {
    return [];
  }
}

// An RFC 3339 slot start -> { at, date, hhmm } on the grid and in the window.
function parseStart(ctx, start) {
  const at = new Date(String(start ?? ""));
  if (Number.isNaN(at.getTime())) throw new HttpError(400, "invalid_start");
  const date = chicagoDateString(at);
  const hhmm = chicagoTime(at);
  if (!ctx.settings.slotStarts.includes(hhmm) || !windowDates(ctx).includes(date)) throw new HttpError(400, "invalid_start");
  return { at: chicagoInstant(date, hhmm), date, hhmm };
}

// Everything a booking route needs, or a 503 that says what is missing.
async function context(req) {
  const config = req.bookingConfig;
  if (!config.enabled) throw new HttpError(503, "booking_disabled");
  const missing = [
    !config.areaTokenSecret && "BOOKING_AREA_TOKEN_SECRET",
    !config.ownerAccountId && "GOOGLE_CALENDAR_ACCOUNT_ID",
    !calendarConfigured() && "GOOGLE_CALENDAR_*",
    !routesConfigured() && "GOOGLE_MAPS_API_KEY"
  ].filter(Boolean);
  if (missing.length) throw new HttpError(503, "not_configured", { missing });
  await bookingIndexesReady();
  const now = new Date();
  return {
    config,
    now,
    ip: req.ip || "",
    settings: await getSlotFinderSettings(config.ownerAccountId),
    drive: makeBookingDrive({ config, now })
  };
}

const route = (handler) => async (req, res, next) => {
  try {
    await handler(req, res);
  } catch (error) {
    next(error);
  }
};

// ── handlers ──

router.get(
  "/status",
  route(async (req, res) => {
    const config = req.bookingConfig;
    res.json({
      enabled: config.enabled,
      modes: {
        calendar: calendarConfigured() ? "google" : "off",
        drive: routesConfigured() ? "google" : "off",
        geocode: "census",
        push: isPushConfigured() ? "on" : "off",
        email: String(process.env.RESEND_API_KEY || "").trim() ? "resend" : "log",
        customerEmail: String(process.env.BOOKING_EMAIL_FROM || "").trim() ? "resend" : "log",
        sms: "log",
        turnstile: config.turnstileSecret ? "on" : "off",
        serviceArea: config.serviceArea ? "polygon+drive" : "drive-only"
      }
    });
  })
);

router.post(
  "/suggest",
  route(async (req, res) => {
    const ctx = await context(req);
    await rateLimit(ctx, "suggest");
    const text = stripHtml(req.body?.q).slice(0, 120);
    if (text.length < 4) return res.json({ exact: null, streets: [] });
    const [match, found] = await Promise.all([/^\d+[A-Za-z]?\s+\S{3}/.test(text) ? resolveAddress(text) : null, autocomplete(text)]);
    const exact = match ? { address: match.address, line1: match.line1, line2: match.line2, city: match.city, zip: match.zip } : null;
    const streets = found
      .filter((street) => !(exact && sameStreetLine(street.line1, exact.line1) && street.city.toLowerCase() === exact.city.toLowerCase()))
      .map((street) => ({ label: street.label, line1: street.line1, line2: street.line2, city: street.city, hasNumber: /^\d/.test(street.line1) }));
    return res.json({ exact, streets });
  })
);

router.post(
  "/check-area",
  route(async (req, res) => {
    const ctx = await context(req);
    await rateLimit(ctx, "checkArea");
    const body = req.body || {};
    if (!(await verifyTurnstile(body.turnstileToken, ctx.ip, ctx.config))) throw new HttpError(403, "turnstile_failed");
    const address = stripHtml(body.address).slice(0, 200);
    if (!address) throw new HttpError(400, "address_required");

    // Client coordinates are never trusted: the address is looked up here.
    const place = await resolveAddress(address);
    if (!place || place.state !== "TX" || !Number.isFinite(place.lat)) {
      log("booking_rejected", { route: "check-area", reason: place ? "not_texas" : "unparseable" });
      return res.json({ inside: false, reason: "outside_area" });
    }
    const point = { lat: place.lat, lng: place.lng };
    if (ctx.config.serviceArea && !pointInGeoJson(point, ctx.config.serviceArea)) {
      log("booking_rejected", { route: "check-area", reason: "outside_polygon" });
      return res.json({ inside: false, reason: "outside_area" });
    }
    const [fromHome] = await ctx.drive([{ from: ctx.settings.homeBase, to: place.address, departAt: ctx.now }]);
    if (fromHome.unreachable || fromHome.minutes > ctx.config.maxDriveMin) {
      log("booking_rejected", { route: "check-area", reason: fromHome.unreachable ? "unreachable" : "drive_cap" });
      return res.json({ inside: false, reason: "outside_area" });
    }
    const areaToken = signAreaToken({ a: place.address, p: point, k: addressKeyOf(place.address) }, ctx.config.areaTokenSecret, {
      now: ctx.now.getTime()
    });
    log("booking_area_inside", { polygon: Boolean(ctx.config.serviceArea) });
    return res.json({ inside: true, areaToken, address: place.address });
  })
);

router.get(
  "/days",
  route(async (req, res) => {
    const ctx = await context(req);
    await rateLimit(ctx, "slots");
    const area = requireArea(ctx, req.query.areaToken);
    // The customer's own hold still counts as open for them.
    const holdId = typeof req.query.holdId === "string" ? req.query.holdId : null;
    const byDate = await offered(ctx, area, windowDates(ctx), { exceptHoldId: holdId });
    res.json([...byDate].filter(([, slots]) => slots.length > 0).map(([date, slots]) => ({ date, free: slots.length })));
  })
);

router.get(
  "/slots",
  route(async (req, res) => {
    const ctx = await context(req);
    await rateLimit(ctx, "slots");
    const area = requireArea(ctx, req.query.areaToken);
    const date = String(req.query.date || "");
    if (!isValidDateString(date) || !windowDates(ctx).includes(date)) throw new HttpError(400, "invalid_date");
    const holdId = typeof req.query.holdId === "string" ? req.query.holdId : null;
    res.json(publicSlots((await offered(ctx, area, [date], { exceptHoldId: holdId })).get(date)));
  })
);

router.post(
  "/hold",
  route(async (req, res) => {
    const ctx = await context(req);
    await rateLimit(ctx, "hold");
    const body = req.body || {};
    const area = requireArea(ctx, body.areaToken);
    const { at, date, hhmm } = parseStart(ctx, body.start);
    const accountId = ctx.config.ownerAccountId;
    if (typeof body.replaceHoldId === "string" && body.replaceHoldId) await releaseOwnHold(accountId, body.replaceHoldId, area.k);

    const fits = ((await offered(ctx, area, [date])).get(date) || []).some((slot) => slot.start === hhmm);
    if (!fits) {
      log("booking_rejected", { route: "hold", reason: "slot_unavailable" });
      throw new HttpError(409, "slot_taken", { slots: await freshSlots(ctx, area, date) });
    }
    const held = await placeHold(
      accountId,
      {
        slotKey: `${date}T${hhmm}`,
        date,
        start: at,
        end: addMinutes(at, ctx.config.jobMinutes),
        holdMinutes: ctx.config.holdMinutes,
        area: { address: area.a, lat: area.p.lat, lng: area.p.lng, key: area.k }
      },
      ctx.now
    );
    if (!held.ok) {
      log("booking_rejected", { route: "hold", reason: "conflict" });
      throw new HttpError(409, "slot_taken", { slots: await freshSlots(ctx, area, date) });
    }
    res.json({ holdId: held.holdId, start: toChicagoRfc3339(at), expiresAt: held.expiresAt.toISOString() });
  })
);

// The customer changed their address or left: free their held time for others
// now instead of in 10 minutes. Only their own plain hold (same address).
router.post(
  "/release",
  route(async (req, res) => {
    const ctx = await context(req);
    await rateLimit(ctx, "slots");
    const body = req.body || {};
    const area = requireArea(ctx, body.areaToken);
    const released = await releaseOwnHold(ctx.config.ownerAccountId, body.holdId, area.k);
    res.json({ released });
  })
);

function validateBooking(body) {
  const name = stripHtml(body.name).slice(0, 60);
  if (name.length < 2) throw new HttpError(400, "invalid_name");
  const phone = toE164(body.phone);
  if (!phone) throw new HttpError(400, "invalid_phone");
  const email = String(body.email ?? "").trim();
  if (email && (email.length > 254 || !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email))) throw new HttpError(400, "invalid_email");
  if (!Object.hasOwn(SERVICES, body.service)) throw new HttpError(400, "invalid_service");
  const service = SERVICES[body.service];
  const devices = DEVICES[service.devices];
  if (!Object.hasOwn(devices, body.console)) throw new HttpError(400, "invalid_console");
  let issue = "";
  if (service.describe) {
    issue = stripHtmlKeepLines(body.issue).slice(0, 300);
    if (issue.length < 3) throw new HttpError(400, "issue_required");
  }
  const notes = stripHtmlKeepLines(body.notes).slice(0, 500);
  const utmIn = body.utm && typeof body.utm === "object" ? body.utm : {};
  const clip = (value) => stripHtml(value).slice(0, 200);
  const utm = { source: clip(utmIn.source), medium: clip(utmIn.medium), campaign: clip(utmIn.campaign), referrer: clip(utmIn.referrer) };
  return {
    name,
    phone,
    email,
    service: body.service,
    serviceLabel: service.label,
    issue,
    device: devices[body.console],
    notes,
    smsConsent: body.smsConsent === true,
    language: body.language === "es" ? "es" : "en",
    utm,
    leadSource: utm.source ? [utm.source, utm.medium, utm.campaign].filter(Boolean).join(" / ") : utm.referrer ? `referral: ${utm.referrer}` : "direct"
  };
}

// Waits for the notifications, but never longer than this: on App Engine work
// after the response is not guaranteed to run.
const NOTIFY_WAIT_MS = 6000;

router.post(
  "/book",
  route(async (req, res) => {
    const ctx = await context(req);
    const idempotencyKey = String(req.get("Idempotency-Key") || "");
    if (!/^[\w-]{8,100}$/.test(idempotencyKey)) throw new HttpError(400, "idempotency_key_required");
    const body = req.body || {};
    if (!(await verifyTurnstile(body.turnstileToken, ctx.ip, ctx.config))) throw new HttpError(403, "turnstile_failed");

    const begun = await beginRequest(idempotencyKey, ctx.now);
    if (begun.state === "done") {
      res.set("Idempotent-Replay", "true");
      return res.json(begun.result);
    }
    if (begun.state === "pending") throw new HttpError(409, "in_progress");

    const accountId = ctx.config.ownerAccountId;
    let claimedHoldId = null;
    try {
      const details = validateBooking(body);
      const hold = await getHold(accountId, body.holdId, ctx.now);
      if (!hold) throw new HttpError(409, "hold_expired");
      // Counted here, so a replay, a typo or a hold that ran out does not use up
      // one of the day's bookings for this client address.
      await rateLimit(ctx, "book");
      const area = { a: hold.area.address, p: { lat: hold.area.lat, lng: hold.area.lng }, k: hold.area.key };
      const { date } = hold;
      const hhmm = chicagoTime(new Date(hold.start));

      const cap = await capReason(accountId, { phone: details.phone, addressKey: area.k, date }, ctx.config, ctx.now);
      if (cap) {
        log("booking_rejected", { route: "book", reason: cap, phone: maskPhone(details.phone) });
        throw new HttpError(409, cap);
      }
      const claim = await claimHold(accountId, body.holdId, ctx.now);
      if (!claim.ok) {
        log("booking_rejected", { route: "book", reason: claim.reason });
        throw new HttpError(409, claim.reason === "hold_claimed" ? "slot_taken" : "hold_expired", { slots: await freshSlots(ctx, area, date) });
      }
      claimedHoldId = body.holdId;

      // Last look at the calendar and the route before writing anything.
      const stillFits = ((await offered(ctx, area, [date], { exceptHoldId: claimedHoldId })).get(date) || []).some((slot) => slot.start === hhmm);
      if (!stillFits) {
        await releaseHold(accountId, claimedHoldId);
        claimedHoldId = null;
        log("booking_rejected", { route: "book", reason: "no_longer_fits" });
        throw new HttpError(409, "slot_taken", { slots: await freshSlots(ctx, area, date) });
      }

      const start = new Date(hold.start);
      const end = new Date(hold.end);
      const bookingId = bookingCode();
      const event = await insertEvent(
        {
          summary: `${details.serviceLabel} - ${details.name}`,
          location: area.a,
          start: { dateTime: toChicagoRfc3339(start), timeZone: "America/Chicago" },
          end: { dateTime: toChicagoRfc3339(end), timeZone: "America/Chicago" },
          description: [
            `Phone: <a href="tel:${details.phone}">${details.phone}</a>`,
            `Device: ${details.device}`,
            `Service: ${details.serviceLabel}`,
            ...(details.issue ? [`What's wrong: ${details.issue}`] : []),
            `Notes: ${details.notes || "none"}`,
            `Booking ID: ${bookingId}`,
            `Lead source: ${details.leadSource}`,
            "Booked online"
          ].join("\n"),
          colorId: ctx.config.eventColorId,
          reminders: { useDefault: false, overrides: [{ method: "popup", minutes: 60 }] },
          extendedProperties: { private: { bookingId, source: "web" } }
        },
        { calendarId: ctx.config.calendarId }
      );

      let booking;
      try {
        booking = await Booking.create({
          accountId,
          bookingId,
          date,
          start,
          end,
          ...details,
          address: area.a,
          addressKey: area.k,
          lat: area.p.lat,
          lng: area.p.lng,
          calendarId: ctx.config.calendarId,
          eventId: event.id,
          calendarLink: event.htmlLink
        });
      } catch (error) {
        // No record, no event: take the calendar event back off so the time
        // is not blocked by a booking nobody can see.
        await deleteEvent(event.id, { calendarId: ctx.config.calendarId }).catch((undo) =>
          log("booking_event_orphaned", { bookingId, eventId: event.id, error: String(undo?.message || undo) })
        );
        throw error;
      }
      await markBooked(accountId, claimedHoldId, bookingId, ctx.now);
      claimedHoldId = null;

      const result = { bookingId, start: toChicagoRfc3339(start), end: toChicagoRfc3339(end), address: area.a, service: details.serviceLabel, console: details.device };
      await endRequest(idempotencyKey, result);
      log("booking_confirmed", { bookingId, date, time: hhmm, service: details.service, phone: maskPhone(details.phone) });

      await Promise.race([
        notifyBooking(booking.toObject(), ctx.config).catch((error) => log("booking_notify_failed", { error: String(error?.message || error) })),
        new Promise((resolve) => setTimeout(resolve, NOTIFY_WAIT_MS))
      ]);
      return res.json(result);
    } catch (error) {
      if (claimedHoldId) await releaseHold(accountId, claimedHoldId).catch(() => {});
      await endRequest(idempotencyKey, null).catch(() => {});
      throw error;
    }
  })
);

router.use((_req, res) => res.status(404).json({ error: "not_found" }));

// eslint-disable-next-line no-unused-vars
router.use((error, _req, res, _next) => {
  if (error instanceof HttpError) {
    if (error.extra.retryAfterSec) res.set("Retry-After", String(error.extra.retryAfterSec));
    return res.status(error.status).json({ error: error.code, ...error.extra });
  }
  if (error?.type === "entity.parse.failed") return res.status(400).json({ error: "invalid_json" });
  if (error?.type === "entity.too.large") return res.status(413).json({ error: "too_large" });
  if (error instanceof RoutesBudgetError) return res.status(503).json({ error: "maps_budget" });
  if (error instanceof SlotFinderError) {
    log("booking_error", { status: error.status, error: error.message });
    if (error.status === 400) return res.status(400).json({ error: "address_unreachable" });
    return res.status(error.status === 503 ? 503 : 502).json({ error: "upstream_failed" });
  }
  console.error("Booking failed:", error?.stack || error);
  return res.status(500).json({ error: "server_error" });
});

export default router;
