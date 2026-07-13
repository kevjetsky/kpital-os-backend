import { Entry } from "../models/Entry.js";
import { TaxRemittance } from "../models/TaxRemittance.js";
import { roundMoney } from "../utils.js";

// Quarters use the entry's calendar date in UTC. Entries store date-only values
// at UTC midnight, so UTC month/year here matches how the frontend groups the
// tax report (Q1 = Jan–Mar, Q2 = Apr–Jun, Q3 = Jul–Sep, Q4 = Oct–Dec).
export function quarterOfMonth(monthIndex0) {
  return Math.floor(monthIndex0 / 3) + 1;
}

export function periodLabel(year, quarter) {
  return `${year}-Q${quarter}`;
}

export function quarterOfDate(date) {
  const d = date instanceof Date ? date : new Date(date);
  return { year: d.getUTCFullYear(), quarter: quarterOfMonth(d.getUTCMonth()) };
}

// Sum of sales tax collected per quarter for a year. Tips carry salesTax = 0, so
// summing salesTax across all entry types is already tax-exempt-correct.
async function collectedByQuarter(year) {
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year + 1, 0, 1));

  const rows = await Entry.aggregate([
    { $match: { date: { $gte: start, $lt: end } } },
    {
      $group: {
        _id: { $ceil: { $divide: [{ $month: { date: "$date", timezone: "UTC" } }, 3] } },
        collected: { $sum: "$salesTax" }
      }
    }
  ]);

  const map = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const row of rows) {
    map[row._id] = roundMoney(row.collected || 0);
  }
  return map;
}

async function remittedByQuarter(year) {
  const rows = await TaxRemittance.aggregate([
    { $match: { year } },
    { $group: { _id: "$quarter", remitted: { $sum: "$amount" } } }
  ]);

  const map = { 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const row of rows) {
    map[row._id] = roundMoney(row.remitted || 0);
  }
  return map;
}

// Full per-quarter liability picture for a year: collected, remitted, and the
// balance still owed, plus the underlying remittance records.
export async function getLiability(year) {
  const [collected, remitted, remittances] = await Promise.all([
    collectedByQuarter(year),
    remittedByQuarter(year),
    TaxRemittance.find({ year }).sort({ quarter: 1, dateFiled: 1 }).lean()
  ]);

  const quarters = [1, 2, 3, 4].map((quarter) => {
    const owed = roundMoney(collected[quarter] - remitted[quarter]);
    return {
      period: periodLabel(year, quarter),
      quarter,
      collected: collected[quarter],
      remitted: remitted[quarter],
      owed
    };
  });

  const totals = quarters.reduce(
    (acc, q) => {
      acc.collected = roundMoney(acc.collected + q.collected);
      acc.remitted = roundMoney(acc.remitted + q.remitted);
      acc.owed = roundMoney(acc.owed + q.owed);
      return acc;
    },
    { collected: 0, remitted: 0, owed: 0 }
  );

  return {
    year,
    quarters,
    totals,
    remittances: remittances.map((r) => ({
      _id: String(r._id),
      period: r.period,
      year: r.year,
      quarter: r.quarter,
      amount: roundMoney(r.amount || 0),
      dateFiled: r.dateFiled,
      note: r.note || ""
    }))
  };
}

// Collected minus remitted for a single quarter — used by the notification cron
// to remind about a just-closed quarter.
export async function getQuarterOwed(year, quarter) {
  const [collected, remitted] = await Promise.all([collectedByQuarter(year), remittedByQuarter(year)]);
  return {
    period: periodLabel(year, quarter),
    collected: collected[quarter],
    remitted: remitted[quarter],
    owed: roundMoney(collected[quarter] - remitted[quarter])
  };
}
