import { Entry } from "../models/Entry.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { PushSubscription } from "../models/PushSubscription.js";
import { ReferenceOption } from "../models/ReferenceOption.js";
import { Settings } from "../models/Settings.js";
import { CERT_EXPIRY_WARNING_DAYS, PROFIT_NEUTRAL_ENTRY_TYPES } from "../constants.js";
import { roundMoney, toAccountObjectId } from "../utils.js";
import { sendToAccount } from "./notificationService.js";
import { getQuarterOwed, periodLabel, quarterOfDate } from "./taxService.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const money = (n) => `$${roundMoney(n).toFixed(2)}`;

function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Alert when parts newly drop to/below their low-stock threshold. Uses the
// lowStockNotified flag so we alert on the transition, not every run.
async function runLowStock(accountId, prefs, results) {
  if (prefs.lowStock === false) return;

  const items = await InventoryItem.find({ accountId }).lean();
  const newlyLow = [];
  const recoveredIds = [];

  for (const item of items) {
    const isLow = item.quantity <= item.lowStockThreshold;
    if (isLow && !item.lowStockNotified) {
      newlyLow.push(item);
    } else if (!isLow && item.lowStockNotified) {
      recoveredIds.push(item._id);
    }
  }

  if (newlyLow.length > 0) {
    await InventoryItem.updateMany(
      { accountId, _id: { $in: newlyLow.map((i) => i._id) } },
      { $set: { lowStockNotified: true } }
    );
    const names = newlyLow.map((i) => `${i.name} (${i.quantity} left)`).join(", ");
    const body =
      newlyLow.length === 1
        ? `${newlyLow[0].name} is low: ${newlyLow[0].quantity} left.`
        : `${newlyLow.length} parts are low on stock: ${names}.`;
    const push = await sendToAccount(accountId, { title: "Low stock", body, url: "/?tab=inventory", tag: "low-stock" });
    results.lowStock = { alerted: newlyLow.length, push };
  }

  if (recoveredIds.length > 0) {
    await InventoryItem.updateMany(
      { accountId, _id: { $in: recoveredIds } },
      { $set: { lowStockNotified: false } }
    );
  }
}

// On the first run of a new quarter, remind to file the quarter that just
// closed, showing what was collected and what is still owed.
async function runQuarterlyTax(accountId, settings, prefs, now, results) {
  if (prefs.quarterlyTax === false) return;

  const { year, quarter } = quarterOfDate(now);
  const prevQuarter = quarter === 1 ? 4 : quarter - 1;
  const prevYear = quarter === 1 ? year - 1 : year;
  const period = periodLabel(prevYear, prevQuarter);

  if (settings.notificationState?.lastQuarterlyTaxPeriod === period) return;

  const owed = await getQuarterOwed(accountId, prevYear, prevQuarter);
  if (owed.collected > 0) {
    const body = `${period}: you collected ${money(owed.collected)} in sales tax${
      owed.owed > 0 ? `, ${money(owed.owed)} still to remit` : " (fully remitted)"
    }. Time to file.`;
    const push = await sendToAccount(accountId, { title: "Sales tax due", body, url: "/?tab=tax", tag: "quarterly-tax" });
    results.quarterlyTax = { period, ...owed, push };
  }

  settings.notificationState = settings.notificationState || {};
  settings.notificationState.lastQuarterlyTaxPeriod = period;
  await settings.save();
}

// Monday digest of the previous 7 days.
async function runWeeklySummary(accountId, settings, prefs, now, results) {
  if (prefs.weeklySummary === false) return;
  if (now.getUTCDay() !== 1) return; // Mondays only

  const last = settings.notificationState?.lastWeeklySummaryAt;
  if (last && now.getTime() - new Date(last).getTime() < 6 * DAY_MS) return;

  const end = startOfUtcDay(now);
  const start = new Date(end.getTime() - 7 * DAY_MS);

  const [agg] = await Entry.aggregate([
    { $match: { accountId: toAccountObjectId(accountId), date: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: null,
        income: { $sum: "$income" },
        // Owner draws are reported on their own line: they are cash out, but
        // folding them into "out" would make the net look wrong against it.
        expense: {
          $sum: { $cond: [{ $in: ["$type", PROFIT_NEUTRAL_ENTRY_TYPES] }, 0, "$expense"] }
        },
        ownerDraws: {
          $sum: { $cond: [{ $in: ["$type", PROFIT_NEUTRAL_ENTRY_TYPES] }, "$expense", 0] }
        },
        netProfit: { $sum: "$netProfit" },
        count: { $sum: 1 }
      }
    }
  ]);

  const income = roundMoney(agg?.income || 0);
  const expense = roundMoney(agg?.expense || 0);
  const ownerDraws = roundMoney(agg?.ownerDraws || 0);
  const netProfit = roundMoney(agg?.netProfit || 0);
  // The draws clause is appended only when there were any, so a quiet week keeps
  // the notification to one line on the lock screen.
  const drawsPart = ownerDraws > 0 ? `, draws ${money(ownerDraws)}` : "";
  const body = `Last 7 days: ${money(income)} in, ${money(expense)} out, net ${money(netProfit)}${drawsPart} (${agg?.count || 0} entries).`;
  const push = await sendToAccount(accountId, { title: "Weekly summary", body, url: "/", tag: "weekly-summary" });
  results.weeklySummary = { income, expense, ownerDraws, netProfit, count: agg?.count || 0, push };

  settings.notificationState = settings.notificationState || {};
  settings.notificationState.lastWeeklySummaryAt = now;
  await settings.save();
}

const shortDate = (date) =>
  new Date(date).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

// Warn before a business's tax-exempt certificate lapses, and again once it
// has. Each stage fires once per certificate date: the marker stored on the
// business names the stage and the date, so entering a renewed date re-arms it.
async function runCertExpiry(accountId, prefs, now, results) {
  if (prefs.certExpiry === false) return;

  const today = startOfUtcDay(now);
  const businesses = await ReferenceOption.find({
    accountId,
    kind: "business",
    taxExempt: true,
    taxExemptExpiresAt: { $ne: null }
  }).lean();

  const due = [];
  for (const business of businesses) {
    const expires = startOfUtcDay(business.taxExemptExpiresAt);
    const daysLeft = Math.round((expires.getTime() - today.getTime()) / DAY_MS);
    const stage = daysLeft < 0 ? "expired" : daysLeft <= CERT_EXPIRY_WARNING_DAYS ? "soon" : "";
    if (!stage) continue;
    const marker = `${stage}:${expires.toISOString().slice(0, 10)}`;
    if (business.taxExemptReminder === marker) continue;
    due.push({ business, stage, daysLeft, expires, marker });
  }
  if (due.length === 0) return;

  const describe = ({ business, stage, daysLeft, expires }) =>
    stage === "expired"
      ? `${business.name}'s certificate expired ${shortDate(expires)}`
      : `${business.name}'s certificate expires ${daysLeft === 0 ? "today" : `in ${daysLeft} day${daysLeft === 1 ? "" : "s"}`} (${shortDate(expires)})`;
  const anyExpired = due.some((item) => item.stage === "expired");
  const body = `${due.map(describe).join("; ")}.${
    anyExpired ? " New records for an expired certificate charge sales tax until it is renewed." : ""
  }`;
  const push = await sendToAccount(accountId, {
    title: "Tax-exempt certificate",
    body,
    url: "/?tab=b2b",
    tag: "cert-expiry"
  });

  for (const item of due) {
    await ReferenceOption.updateOne(
      { _id: item.business._id, accountId },
      { $set: { taxExemptReminder: item.marker } }
    );
  }
  results.certExpiry = { alerted: due.length, expired: due.filter((item) => item.stage === "expired").length, push };
}

// Tell the owner once when a B2B record on payment terms goes past its due date
// unpaid. overdueNotified keeps it to the transition, like the low-stock flag.
async function runOverdueInvoices(accountId, prefs, now, results) {
  if (prefs.overdueInvoices === false) return;

  const entries = await Entry.find({
    accountId,
    isB2B: true,
    dueDate: { $ne: null, $lt: startOfUtcDay(now) },
    status: { $ne: "Paid" },
    type: { $ne: "Refund" },
    overdueNotified: { $ne: true }
  }).lean();
  if (entries.length === 0) return;

  const owedByBusiness = new Map();
  let total = 0;
  for (const entry of entries) {
    const paid = (entry.payments || []).reduce((sum, payment) => sum + (payment.amount || 0), 0);
    const owed = Math.max(0, roundMoney((entry.income || 0) + (entry.salesTax || 0) - paid));
    const name = entry.businessName || "Unknown business";
    owedByBusiness.set(name, roundMoney((owedByBusiness.get(name) || 0) + owed));
    total = roundMoney(total + owed);
  }

  const breakdown = Array.from(owedByBusiness.entries())
    .map(([name, owed]) => `${name} ${money(owed)}`)
    .join(", ");
  const body = `${entries.length} B2B record${entries.length === 1 ? " is" : "s are"} now past due, ${money(total)} in total: ${breakdown}.`;
  const push = await sendToAccount(accountId, { title: "Payment overdue", body, url: "/?tab=b2b", tag: "overdue-invoices" });

  await Entry.updateMany(
    { accountId, _id: { $in: entries.map((entry) => entry._id) } },
    { $set: { overdueNotified: true } }
  );
  results.overdueInvoices = { alerted: entries.length, total, push };
}

// Entry point for the daily notifications cron. Evaluates every trigger and
// returns a summary of what fired.
export async function runNotifications(now = new Date()) {
  // One pass per account. Each account's triggers, dedupe markers and devices
  // are independent, so a quiet account never suppresses a noisy one.
  const accounts = await Settings.find({}).select("_id notificationPrefs notificationState");
  if (accounts.length === 0) {
    return { skipped: "no-settings" };
  }

  const byAccount = {};
  for (const settings of accounts) {
    const accountId = settings._id;

    // No devices subscribed yet: skip entirely so dedupe markers (low-stock
    // flags, quarterly/weekly timestamps) aren't consumed by runs nobody hears.
    // The first cron after a device subscribes will deliver everything due.
    const subscribers = await PushSubscription.countDocuments({ accountId });
    if (subscribers === 0) {
      byAccount[String(accountId)] = { skipped: "no-subscribers" };
      continue;
    }

    const prefs = settings.notificationPrefs || {};
    const results = {};

    await runLowStock(accountId, prefs, results);
    await runQuarterlyTax(accountId, settings, prefs, now, results);
    await runWeeklySummary(accountId, settings, prefs, now, results);
    await runCertExpiry(accountId, prefs, now, results);
    await runOverdueInvoices(accountId, prefs, now, results);

    byAccount[String(accountId)] = results;
  }

  return { accounts: byAccount };
}
