// What the dashboard shows, worked out here so the phone never has to download
// the account's whole history to show it.
import mongoose from "mongoose";
import { Entry } from "../models/Entry.js";
import { ReferenceOption } from "../models/ReferenceOption.js";
import { PROFIT_NEUTRAL_ENTRY_TYPES } from "../constants.js";
import { roundMoney, toAccountObjectId } from "../utils.js";
import { chicagoDateString } from "../slotFinder/time.js";
import {
  chargedLines,
  handleKey,
  isOverdue,
  lineMatches,
  matchesByNameOnly,
  matchesCustomer,
  matchesProductService,
  phoneKey,
  textKey,
  unpaidAmount
} from "./matching.js";

const LINE_ITEM_TYPES = ["Repair", "Sales"];
const JOB_TYPES = ["Repair", "Sales", "Refund"];
const SLIM_FIELDS =
  "_id date type income expense salesTax status jobStatus payments dueDate isB2B businessOptionId customerOptionId " +
  "customerName customerPhone customerInstagram customerEmail items productServiceOptionId productServiceName productServiceType";

const jobStatusOf = (entry) => entry.jobStatus || (entry.status === "Pending" ? "In progress" : "Done");
export const businessToday = (now = new Date()) => chicagoDateString(now);

function push(map, key, value) {
  if (!key) return;
  const bucket = map.get(key);
  if (bucket) bucket.push(value);
  else map.set(key, [value]);
}

/**
 * Money in and out per calendar day, across all time. A few hundred rows a year,
 * from which the phone draws every chart, the year-over-year card and the
 * fallback totals. Owner draws are kept apart from expenses.
 */
export async function dailyTotals(accountId) {
  const rows = await Entry.aggregate([
    { $match: { accountId: toAccountObjectId(accountId) } },
    {
      $group: {
        _id: { $dateToString: { date: "$date", format: "%Y-%m-%d", timezone: "UTC" } },
        income: { $sum: "$income" },
        expense: { $sum: { $cond: [{ $in: ["$type", PROFIT_NEUTRAL_ENTRY_TYPES] }, 0, "$expense"] } },
        ownerDraws: { $sum: { $cond: [{ $in: ["$type", PROFIT_NEUTRAL_ENTRY_TYPES] }, "$expense", 0] } },
        salesTax: { $sum: "$salesTax" },
        net: { $sum: "$netProfit" }
      }
    },
    { $sort: { _id: 1 } }
  ]);
  return rows.map((row) => ({
    date: row._id,
    income: roundMoney(row.income),
    expense: roundMoney(row.expense),
    ownerDraws: roundMoney(row.ownerDraws),
    salesTax: roundMoney(row.salesTax),
    net: roundMoney(row.net)
  }));
}

// Each record is indexed once by every way it can point at a customer, then
// each customer looks itself up, rather than rescanning every record per customer.
export function customerStats(entries, customers) {
  const byId = new Map();
  const byEmail = new Map();
  const byPhone = new Map();
  const byHandle = new Map();
  const byName = new Map();
  for (const entry of entries) {
    if (entry.customerOptionId) push(byId, String(entry.customerOptionId), entry);
    push(byEmail, textKey(entry.customerEmail), entry);
    push(byPhone, phoneKey(entry.customerPhone), entry);
    push(byHandle, handleKey(entry.customerInstagram), entry);
    if (matchesByNameOnly(entry)) push(byName, textKey(entry.customerName), entry);
  }
  const find = (map, key) => (key ? map.get(key) || [] : []);

  const stats = {};
  for (const customer of customers) {
    let revenue = 0;
    let lastDate = "";
    const seen = new Set();
    const take = (entry) => {
      const id = String(entry._id);
      if (seen.has(id)) return;
      seen.add(id);
      revenue += entry.income || 0;
      const date = new Date(entry.date).toISOString();
      if (!lastDate || date > lastDate) lastDate = date;
    };
    find(byId, String(customer._id)).forEach(take);
    find(byEmail, textKey(customer.email)).forEach(take);
    find(byPhone, phoneKey(customer.phone)).forEach(take);
    find(byHandle, handleKey(customer.instagram)).forEach(take);
    find(byName, textKey(customer.name)).forEach(take);
    stats[String(customer._id)] = { revenue: roundMoney(revenue), count: seen.size, lastDate };
  }
  return stats;
}

export function productServiceStats(entries, productServices) {
  const byId = new Map();
  const byName = new Map();
  for (const entry of entries) {
    const lines = chargedLines(entry);
    for (const line of lines) {
      const charged = { entry, line, lineCount: lines.length };
      if (line.optionId) push(byId, line.optionId, charged);
      push(byName, textKey(line.name), charged);
    }
  }

  const stats = {};
  for (const item of productServices) {
    let revenue = 0;
    let cost = 0;
    let lastDate = "";
    const seenLines = new Set();
    const seenEntries = new Set();
    const take = ({ entry, line, lineCount }) => {
      if (seenLines.has(line) || !lineMatches(line, item)) return;
      seenLines.add(line);
      revenue += line.amount;
      // A job's costs are shared across its lines by what each line charged.
      cost += entry.income > 0 ? (entry.expense || 0) * (line.amount / entry.income) : lineCount === 1 ? entry.expense || 0 : 0;
      const id = String(entry._id);
      if (!seenEntries.has(id)) {
        seenEntries.add(id);
        const date = new Date(entry.date).toISOString();
        if (!lastDate || date > lastDate) lastDate = date;
      }
    };
    (byId.get(String(item._id)) || []).forEach(take);
    (byName.get(textKey(item.name)) || []).forEach(take);
    stats[String(item._id)] = {
      revenue: roundMoney(revenue),
      count: seenEntries.size,
      lastDate,
      cost: roundMoney(cost),
      profit: roundMoney(revenue - cost)
    };
  }
  return stats;
}

export function businessStats(entries, onDay) {
  const stats = {};
  let overdueCount = 0;
  for (const entry of entries) {
    if (!entry.isB2B || !entry.businessOptionId) continue;
    const key = String(entry.businessOptionId);
    const stat = stats[key] || { count: 0, sales: 0, unpaid: 0, overdue: 0, overdueCount: 0, lastDate: "" };
    const owed = unpaidAmount(entry);
    stat.count += 1;
    stat.sales = roundMoney(stat.sales + (entry.type === "Refund" ? -(entry.expense || 0) : entry.income || 0));
    stat.unpaid = roundMoney(stat.unpaid + owed);
    if (isOverdue(entry, onDay)) {
      stat.overdue = roundMoney(stat.overdue + owed);
      stat.overdueCount += 1;
      overdueCount += 1;
    }
    const date = new Date(entry.date).toISOString();
    if (!stat.lastDate || date > stat.lastDate) stat.lastDate = date;
    stats[key] = stat;
  }
  return { stats, overdueCount };
}

/** The catalog items used most across the latest 300 jobs, for one-tap picks. */
export function topServiceIds(entries, limit = 6) {
  const recent = entries
    .filter((entry) => JOB_TYPES.includes(entry.type))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, 300);
  const uses = new Map();
  for (const entry of recent) {
    for (const line of chargedLines(entry)) if (line.optionId) uses.set(line.optionId, (uses.get(line.optionId) || 0) + 1);
  }
  return [...uses.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([id]) => id);
}

export async function insights(accountId, now = new Date()) {
  const [daily, entries, customers, productServices] = await Promise.all([
    dailyTotals(accountId),
    Entry.find({ accountId }).select(SLIM_FIELDS).lean(),
    ReferenceOption.find({ accountId, kind: "customer" }).select("_id name phone email instagram").lean(),
    ReferenceOption.find({ accountId, kind: "product_service" }).select("_id name optionType").lean()
  ]);
  const business = businessStats(entries, businessToday(now));
  return {
    generatedAt: now.toISOString(),
    daily,
    customerStats: customerStats(entries, customers),
    productServiceStats: productServiceStats(entries, productServices),
    businessStats: business.stats,
    overdueCount: business.overdueCount,
    topServiceIds: topServiceIds(entries)
  };
}

/**
 * A working day (today unless a YYYY-MM-DD date is given): its jobs in full,
 * for the schedule and the route, plus how many jobs are waiting to be handed
 * back and what is still owed overall.
 */
export async function today(accountId, now = new Date(), date = null) {
  const day = date || businessToday(now);
  const [jobs, open] = await Promise.all([
    Entry.find({ accountId, date: new Date(`${day}T00:00:00.000Z`), type: { $in: JOB_TYPES } })
      .sort({ scheduledTime: 1, createdAt: 1 })
      .lean(),
    Entry.find({ accountId, type: { $in: LINE_ITEM_TYPES }, $or: [{ status: { $ne: "Paid" } }, { jobStatus: "Ready" }] })
      .select("type income salesTax status jobStatus payments")
      .lean()
  ]);
  let readyCount = 0;
  let owedCount = 0;
  let owedTotal = 0;
  for (const entry of open) {
    if (jobStatusOf(entry) === "Ready") readyCount += 1;
    if (entry.status !== "Paid") {
      owedCount += 1;
      owedTotal += unpaidAmount(entry);
    }
  }
  return { date: day, jobs, todayCount: jobs.length, readyCount, owedCount, owedTotal: roundMoney(owedTotal) };
}

const MAX_RELATED = 500;

/** Every record tied to one customer, catalog item or business, newest first. */
export async function related(accountId, { customerId, productServiceId, businessId }) {
  const valid = (id) => mongoose.Types.ObjectId.isValid(String(id || ""));
  if (businessId) {
    if (!valid(businessId)) return { error: "Invalid businessId." };
    const entries = await Entry.find({ accountId, isB2B: true, businessOptionId: businessId })
      .sort({ date: -1, createdAt: -1 })
      .limit(MAX_RELATED)
      .lean();
    return { entries };
  }

  const kind = customerId ? "customer" : productServiceId ? "product_service" : null;
  const id = customerId || productServiceId;
  if (!kind) return { error: "Pass customerId, productServiceId or businessId." };
  if (!valid(id)) return { error: `Invalid ${customerId ? "customerId" : "productServiceId"}.` };
  const option = await ReferenceOption.findOne({ _id: id, accountId, kind }).lean();
  if (!option) return { notFound: true };

  // Matching reads phone numbers and names in several forms, so it runs over a
  // light copy of every record here; only the matches are sent in full.
  const slim = await Entry.find({ accountId }).select(SLIM_FIELDS).lean();
  const matches = (kind === "customer" ? slim.filter((entry) => matchesCustomer(entry, option)) : slim.filter((entry) => matchesProductService(entry, option)))
    .sort((a, b) => new Date(b.date) - new Date(a.date))
    .slice(0, MAX_RELATED)
    .map((entry) => entry._id);
  const entries = await Entry.find({ accountId, _id: { $in: matches } }).sort({ date: -1, createdAt: -1 }).lean();
  return { entries };
}

const AREA_FIELDS =
  "_id date type income expense netProfit customerPhone customerOptionId customerInstagram customerAddress businessOptionId " +
  "addressZip addressCity addressState addressNeighborhood addressLat addressLng";

/**
 * Every sale, repair and refund, carrying only where it was and what it made:
 * the Areas screen needs the ones with no address too, to say how many jobs
 * it cannot place.
 */
export function areaPoints(accountId) {
  return Entry.find({ accountId, type: { $in: JOB_TYPES } })
    .select(AREA_FIELDS)
    .sort({ date: -1 })
    .lean();
}

