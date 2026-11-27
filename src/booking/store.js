// Holds, bookings, request replays and counters in MongoDB. Every step that
// must not race (taking a time, claiming a hold) is one atomic Mongo operation,
// so it holds across App Engine instances.
import { Booking, BookingCounter, BookingLock, BookingRequest } from "./models.js";

// The Google Calendar event exists by now; after this the calendar decides.
export const BOOKED_LOCK_MS = 5 * 60 * 1000;
// A claim is the few seconds between "Confirm" and the calendar event.
const CLAIM_MS = 2 * 60 * 1000;
// An Idempotency-Key still "pending" after this is a request that died.
const STALE_REQUEST_MS = 2 * 60 * 1000;

const isDuplicate = (error) => error?.code === 11000;

// Active locks on these dates. The customer's own hold (`exceptHoldId`, for the
// same address) is left out, so they still see the time they are holding.
export async function activeLocks(accountId, dates, now, { exceptHoldId = null, addressKey = null } = {}) {
  const locks = await BookingLock.find({ accountId, date: { $in: dates }, expiresAt: { $gt: now } }).lean();
  return locks.filter(
    (lock) => !(exceptHoldId && String(lock._id) === String(exceptHoldId) && (!addressKey || lock.area?.key === addressKey))
  );
}

// Takes the time for a customer, or { ok: false } when someone else has it.
export async function placeHold(accountId, { slotKey, date, start, end, holdMinutes, area }, now) {
  // A lock that has run out no longer counts; clear it so the unique index frees up.
  await BookingLock.deleteOne({ accountId, slotKey, expiresAt: { $lte: now } });
  try {
    const lock = await BookingLock.create({
      accountId,
      slotKey,
      date,
      start,
      end,
      kind: "hold",
      expiresAt: new Date(now.getTime() + holdMinutes * 60000),
      area
    });
    return { ok: true, holdId: String(lock._id), expiresAt: lock.expiresAt };
  } catch (error) {
    if (isDuplicate(error)) return { ok: false };
    throw error;
  }
}

const validId = (id) => typeof id === "string" && /^[a-f0-9]{24}$/.test(id);

export async function releaseHold(accountId, holdId) {
  if (!validId(holdId)) return;
  await BookingLock.deleteOne({ accountId, _id: holdId, kind: { $in: ["hold", "claimed"] } });
}

// A customer letting go of their own hold (a new time, a new address): only a
// plain hold, and only for the address that placed it. Never a booking in progress.
export async function releaseOwnHold(accountId, holdId, addressKey) {
  if (!validId(holdId) || !addressKey) return false;
  const { deletedCount } = await BookingLock.deleteOne({ accountId, _id: holdId, kind: "hold", "area.key": addressKey });
  return deletedCount > 0;
}

export async function getHold(accountId, holdId, now) {
  if (!validId(holdId)) return null;
  return BookingLock.findOne({ accountId, _id: holdId, kind: "hold", expiresAt: { $gt: now } }).lean();
}

// Turns a live hold into a claim, once. { ok, reason }.
export async function claimHold(accountId, holdId, now) {
  if (!validId(holdId)) return { ok: false, reason: "hold_expired" };
  const claimed = await BookingLock.findOneAndUpdate(
    { accountId, _id: holdId, kind: "hold", expiresAt: { $gt: now } },
    { $set: { kind: "claimed", expiresAt: new Date(now.getTime() + CLAIM_MS) } },
    { new: true }
  ).lean();
  if (claimed) return { ok: true, lock: claimed };
  const existing = await BookingLock.findOne({ accountId, _id: holdId, expiresAt: { $gt: now } }).lean();
  return { ok: false, reason: existing ? "hold_claimed" : "hold_expired" };
}

export async function markBooked(accountId, holdId, bookingId, now) {
  await BookingLock.updateOne(
    { accountId, _id: holdId },
    { $set: { kind: "booked", bookingId, expiresAt: new Date(now.getTime() + BOOKED_LOCK_MS) } }
  );
}

// The phone and address caps, checked before a booking is written.
export async function capReason(accountId, { phone, addressKey, date }, config, now) {
  const [byPhone, byAddress] = await Promise.all([
    Booking.countDocuments({ accountId, phone, status: "booked", start: { $gt: now } }),
    Booking.countDocuments({ accountId, addressKey, date, status: "booked" })
  ]);
  if (byPhone >= config.maxActivePerPhone) return "phone_cap";
  if (byAddress >= config.maxPerAddressPerDay) return "address_cap";
  return null;
}

// ── Idempotency-Key ──

// { state: "new" } to go ahead, { state: "done", result } to replay, or
// { state: "pending" } while the first request is still running.
export async function beginRequest(key, now) {
  try {
    await BookingRequest.create({ _id: key, state: "pending", createdAt: now });
    return { state: "new" };
  } catch (error) {
    if (!isDuplicate(error)) throw error;
  }
  const existing = await BookingRequest.findById(key).lean();
  if (!existing) return beginRequest(key, now);
  if (existing.state === "done") return { state: "done", result: existing.result };
  if (now.getTime() - new Date(existing.createdAt).getTime() > STALE_REQUEST_MS) {
    const taken = await BookingRequest.findOneAndUpdate(
      { _id: key, state: "pending", createdAt: existing.createdAt },
      { $set: { createdAt: now } }
    ).lean();
    if (taken) return { state: "new" };
  }
  return { state: "pending" };
}

// A result is kept for replays; no result (a failure) frees the key for a retry.
export async function endRequest(key, result) {
  if (result) await BookingRequest.updateOne({ _id: key }, { $set: { state: "done", result } });
  else await BookingRequest.deleteOne({ _id: key, state: "pending" });
}

// ── counters ──

// Fixed-window rate limit. { ok, retryAfterSec }.
export async function countRequest({ bucket, subject, limit, windowSec }, now) {
  const windowMs = windowSec * 1000;
  const windowStart = Math.floor(now.getTime() / windowMs) * windowMs;
  const doc = await BookingCounter.findOneAndUpdate(
    { _id: `rl:${bucket}:${subject}:${windowStart}` },
    { $inc: { count: 1 }, $setOnInsert: { expiresAt: new Date(windowStart + windowMs + 60000) } },
    { upsert: true, new: true }
  ).lean();
  if (doc.count <= limit) return { ok: true };
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((windowStart + windowMs - now.getTime()) / 1000)) };
}

// Spends `elements` of today's Routes allowance. false once it is used up.
export async function spendRoutes(day, elements, cap) {
  if (elements <= 0) return true;
  const doc = await BookingCounter.findOneAndUpdate(
    { _id: `routes:${day}` },
    { $inc: { count: elements }, $setOnInsert: { expiresAt: new Date(Date.now() + 3 * 86400000) } },
    { upsert: true, new: true }
  ).lean();
  return doc.count <= cap;
}
