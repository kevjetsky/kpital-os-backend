import { Entry } from "../models/Entry.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { PushSubscription } from "../models/PushSubscription.js";
import { getMainSettings, roundMoney } from "../utils.js";
import { sendToAll } from "./notificationService.js";
import { getQuarterOwed, periodLabel, quarterOfDate } from "./taxService.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const money = (n) => `$${roundMoney(n).toFixed(2)}`;

function startOfUtcDay(date) {
  const d = new Date(date);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

// Alert when parts newly drop to/below their low-stock threshold. Uses the
// lowStockNotified flag so we alert on the transition, not every run.
async function runLowStock(prefs, results) {
  if (prefs.lowStock === false) return;

  const items = await InventoryItem.find().lean();
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
      { _id: { $in: newlyLow.map((i) => i._id) } },
      { $set: { lowStockNotified: true } }
    );
    const names = newlyLow.map((i) => `${i.name} (${i.quantity} left)`).join(", ");
    const body =
      newlyLow.length === 1
        ? `${newlyLow[0].name} is low: ${newlyLow[0].quantity} left.`
        : `${newlyLow.length} parts are low on stock: ${names}.`;
    const push = await sendToAll({ title: "Low stock", body, url: "/?tab=inventory", tag: "low-stock" });
    results.lowStock = { alerted: newlyLow.length, push };
  }

  if (recoveredIds.length > 0) {
    await InventoryItem.updateMany({ _id: { $in: recoveredIds } }, { $set: { lowStockNotified: false } });
  }
}

// On the first run of a new quarter, remind to file the quarter that just
// closed, showing what was collected and what is still owed.
async function runQuarterlyTax(settings, prefs, now, results) {
  if (prefs.quarterlyTax === false) return;

  const { year, quarter } = quarterOfDate(now);
  const prevQuarter = quarter === 1 ? 4 : quarter - 1;
  const prevYear = quarter === 1 ? year - 1 : year;
  const period = periodLabel(prevYear, prevQuarter);

  if (settings.notificationState?.lastQuarterlyTaxPeriod === period) return;

  const owed = await getQuarterOwed(prevYear, prevQuarter);
  if (owed.collected > 0) {
    const body = `${period}: you collected ${money(owed.collected)} in sales tax${
      owed.owed > 0 ? `, ${money(owed.owed)} still to remit` : " (fully remitted)"
    }. Time to file.`;
    const push = await sendToAll({ title: "Sales tax due", body, url: "/?tab=tax", tag: "quarterly-tax" });
    results.quarterlyTax = { period, ...owed, push };
  }

  settings.notificationState = settings.notificationState || {};
  settings.notificationState.lastQuarterlyTaxPeriod = period;
  await settings.save();
}

// Monday digest of the previous 7 days.
async function runWeeklySummary(settings, prefs, now, results) {
  if (prefs.weeklySummary === false) return;
  if (now.getUTCDay() !== 1) return; // Mondays only

  const last = settings.notificationState?.lastWeeklySummaryAt;
  if (last && now.getTime() - new Date(last).getTime() < 6 * DAY_MS) return;

  const end = startOfUtcDay(now);
  const start = new Date(end.getTime() - 7 * DAY_MS);

  const [agg] = await Entry.aggregate([
    { $match: { date: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: null,
        income: { $sum: "$income" },
        expense: { $sum: "$expense" },
        netProfit: { $sum: "$netProfit" },
        count: { $sum: 1 }
      }
    }
  ]);

  const income = roundMoney(agg?.income || 0);
  const expense = roundMoney(agg?.expense || 0);
  const netProfit = roundMoney(agg?.netProfit || 0);
  const body = `Last 7 days: ${money(income)} in, ${money(expense)} out, net ${money(netProfit)} (${agg?.count || 0} entries).`;
  const push = await sendToAll({ title: "Weekly summary", body, url: "/", tag: "weekly-summary" });
  results.weeklySummary = { income, expense, netProfit, count: agg?.count || 0, push };

  settings.notificationState = settings.notificationState || {};
  settings.notificationState.lastWeeklySummaryAt = now;
  await settings.save();
}

// Entry point for the daily notifications cron. Evaluates every trigger and
// returns a summary of what fired.
export async function runNotifications(now = new Date()) {
  const settings = await getMainSettings();
  if (!settings) {
    return { skipped: "no-settings" };
  }

  // No devices subscribed yet: skip entirely so dedupe markers (low-stock
  // flags, quarterly/weekly timestamps) aren't consumed by runs nobody hears.
  // The first cron after a device subscribes will deliver everything due.
  const subscribers = await PushSubscription.countDocuments();
  if (subscribers === 0) {
    return { skipped: "no-subscribers" };
  }

  const prefs = settings.notificationPrefs || {};
  const results = {};

  await runLowStock(prefs, results);
  await runQuarterlyTax(settings, prefs, now, results);
  await runWeeklySummary(settings, prefs, now, results);

  return results;
}
