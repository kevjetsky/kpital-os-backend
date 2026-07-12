import { RecurringEntry } from "../models/RecurringEntry.js";
import { Entry } from "../models/Entry.js";
import { computeAmounts, roundMoney } from "../utils.js";

// Recurring occurrences are pinned to calendar days. We normalize everything to
// UTC midnight so a template that fires "on the 1st" posts an Entry dated the
// 1st regardless of the server's timezone, matching how Entry dates are stored.
export function startOfUtcDay(value) {
  const date = new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export function todayUtc() {
  return startOfUtcDay(new Date());
}

// Advance a date by one schedule step. Monthly/yearly preserve the day-of-month
// from the anchor (original start day), clamping to the last day of short months
// so e.g. a "31st" template lands on Feb 28.
export function advanceDate(date, frequency, interval, anchorDay) {
  const base = startOfUtcDay(date);
  const step = Math.max(1, Number(interval) || 1);

  if (frequency === "daily") {
    base.setUTCDate(base.getUTCDate() + step);
    return base;
  }
  if (frequency === "weekly") {
    base.setUTCDate(base.getUTCDate() + 7 * step);
    return base;
  }
  if (frequency === "yearly") {
    const day = anchorDay || base.getUTCDate();
    base.setUTCMonth(base.getUTCMonth() + 12 * step, 1);
    return clampDayOfMonth(base, day);
  }
  // monthly (default)
  const day = anchorDay || base.getUTCDate();
  base.setUTCMonth(base.getUTCMonth() + step, 1);
  return clampDayOfMonth(base, day);
}

function clampDayOfMonth(date, day) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastDay)));
}

// Build (but do not persist) the Entry payload for one occurrence on a given date.
function buildEntryPayload(recurring, occurrenceDate) {
  const income = roundMoney(recurring.income || 0);
  const expense = roundMoney(recurring.expense || 0);
  const amounts = computeAmounts(income, expense, recurring.type);

  return {
    date: occurrenceDate,
    type: recurring.type,
    description: recurring.description || "",
    customerName: recurring.customerName || "",
    customerPhone: recurring.customerPhone || "",
    customerInstagram: recurring.customerInstagram || "",
    customerEmail: recurring.customerEmail || "",
    customerAddress: recurring.customerAddress || "",
    customerReference: recurring.customerReference || "",
    customerOptionId: recurring.customerOptionId || null,
    productServiceName: recurring.productServiceName || "",
    productServiceType: recurring.productServiceType || "",
    productServicePrice: roundMoney(recurring.productServicePrice || 0),
    productServiceOptionId: recurring.productServiceOptionId || null,
    inventoryUsage: [],
    inventoryCost: 0,
    ...amounts,
    notes: recurring.notes || "",
    category: recurring.type === "Expenses" ? recurring.category || "" : "",
    status: recurring.status || "Paid"
  };
}

function reachedEnd(recurring, occurrenceDate) {
  if (recurring.endDate && startOfUtcDay(occurrenceDate) > startOfUtcDay(recurring.endDate)) {
    return true;
  }
  if (recurring.maxOccurrences && recurring.occurrenceCount >= recurring.maxOccurrences) {
    return true;
  }
  return false;
}

// Post every occurrence that is due up to and including `asOf` (default today),
// advancing nextRunDate as it goes. Idempotent against re-runs: an occurrence is
// skipped if its date is not strictly after lastPostedDate. Catches up on any
// missed days (e.g. if the cron didn't fire for a stretch).
export async function postDueForRecurring(recurring, asOf = todayUtc()) {
  const anchorDay = startOfUtcDay(recurring.startDate).getUTCDate();
  const created = [];
  let guard = 0;

  while (
    recurring.active &&
    startOfUtcDay(recurring.nextRunDate) <= startOfUtcDay(asOf) &&
    guard < 1000
  ) {
    guard += 1;
    const occurrenceDate = startOfUtcDay(recurring.nextRunDate);

    if (reachedEnd(recurring, occurrenceDate)) {
      recurring.active = false;
      break;
    }

    const alreadyPosted =
      recurring.lastPostedDate && occurrenceDate <= startOfUtcDay(recurring.lastPostedDate);

    if (!alreadyPosted) {
      const entry = await Entry.create(buildEntryPayload(recurring, occurrenceDate));
      created.push(entry);
      recurring.lastPostedDate = occurrenceDate;
      recurring.lastEntryId = entry._id;
      recurring.occurrenceCount += 1;
    }

    const next = advanceDate(occurrenceDate, recurring.frequency, recurring.interval, anchorDay);
    recurring.nextRunDate = next;

    if (reachedEnd(recurring, next)) {
      recurring.active = false;
      break;
    }
  }

  if (created.length > 0 || !recurring.active) {
    await recurring.save();
  }

  return created;
}

// Post all due occurrences across every active recurring template. Returns a
// summary used by the cron endpoint.
export async function postAllDue(asOf = todayUtc()) {
  const due = await RecurringEntry.find({
    active: true,
    nextRunDate: { $lte: asOf }
  });

  let totalPosted = 0;
  const details = [];
  for (const recurring of due) {
    const created = await postDueForRecurring(recurring, asOf);
    if (created.length > 0) {
      totalPosted += created.length;
      details.push({ recurringId: String(recurring._id), name: recurring.name, posted: created.length });
    }
  }

  return { processed: due.length, totalPosted, details };
}
