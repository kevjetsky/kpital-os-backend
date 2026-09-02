// One-off migration: retype the owner's withdrawals from "Payroll" to the new
// "Owner Draw" entry type and zero their stored netProfit.
//
// A member draw in a single-member LLC is a capital distribution, not a
// deductible business expense. Logged as Payroll, every draw was subtracted
// from profit, so the P&L was understated by the full amount withdrawn. The
// money still leaves the account, so the amount stays in `expense`; only the
// profit contribution changes. Real wages stay on Payroll and are untouched.
//
// Usage (from backend/):
//   MONGODB_URI="mongodb+srv://..." node scripts/migrate-owner-draw.mjs
//   MONGODB_URI="..." DRY_RUN=1 node scripts/migrate-owner-draw.mjs   # report only
//
// Safe to run more than once: it only matches entries still typed Payroll, and
// records already converted are reported but not rewritten.

import mongoose from "mongoose";
import { Entry } from "../src/models/Entry.js";

const FROM_TYPE = "Payroll";
const TO_TYPE = "Owner Draw";
// The description the owner's withdrawals were logged under. Deliberately a
// loose match: "Owner withdrawal", "owner withdrawal - Aug", etc.
const DESCRIPTION_MATCH = /owner withdrawal/i;

const DRY_RUN = ["1", "true", "yes"].includes(String(process.env.DRY_RUN || "").toLowerCase());

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

// This migration is deliberately cross-account: it sweeps every business's
// records, so the per-account scoping guard has to be opted out of explicitly.
const ALL_ACCOUNTS = { allowCrossAccount: true };

// Account-wide books totals, so the effect on the P&L is visible either side of
// the rewrite rather than being inferred from the entry list.
async function bookTotals() {
  const [row] = await Entry.aggregate(
    [
      {
        $group: {
          _id: null,
          netProfit: { $sum: "$netProfit" },
          expense: { $sum: "$expense" },
          ownerDraws: {
            $sum: { $cond: [{ $eq: ["$type", TO_TYPE] }, "$expense", 0] }
          },
          count: { $sum: 1 }
        }
      }
    ],
    ALL_ACCOUNTS
  );
  return {
    netProfit: row?.netProfit || 0,
    expense: row?.expense || 0,
    ownerDraws: row?.ownerDraws || 0,
    count: row?.count || 0
  };
}

function printTotals(label, totals) {
  console.log(
    "%s  net profit %s | expense %s | owner draws %s | %d entries",
    label,
    money(totals.netProfit),
    money(totals.expense),
    money(totals.ownerDraws),
    totals.count
  );
}

function printEntries(rows) {
  for (const row of rows) {
    const date = new Date(row.date).toISOString().slice(0, 10);
    const type = String(row.type).padEnd(11);
    const expense = money(row.expense).padEnd(10);
    const net = money(row.netProfit).padEnd(10);
    console.log(
      `  ${date}  ${type}  expense ${expense}  netProfit ${net}  ${row.description || "(no description)"}`
    );
  }
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI is required.");
    process.exit(1);
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  console.log("Connected.%s", DRY_RUN ? " DRY RUN — nothing will be written." : "");

  const filter = { type: FROM_TYPE, description: DESCRIPTION_MATCH };
  const candidates = await Entry.find(filter)
    .setOptions(ALL_ACCOUNTS)
    .sort({ date: 1 })
    .select("date type description expense netProfit salesTax accountId")
    .lean();

  // Anything already converted by a previous run. Reported so a second run
  // reads as "nothing left to do" rather than "found nothing, is this right?".
  const already = await Entry.find({ type: TO_TYPE })
    .setOptions(ALL_ACCOUNTS)
    .sort({ date: 1 })
    .select("date type description expense netProfit")
    .lean();

  console.log("\n=== BEFORE ===");
  const before = await bookTotals();
  printTotals("books:", before);

  if (already.length > 0) {
    console.log("\nAlready %s (%d) — left as-is:", TO_TYPE, already.length);
    printEntries(already);
  }

  console.log("\nTo convert: %d entries matching type %j + /owner withdrawal/i", candidates.length, FROM_TYPE);
  printEntries(candidates);

  const drawTotal = candidates.reduce((sum, row) => sum + (row.expense || 0), 0);
  const profitRecovered = candidates.reduce((sum, row) => sum + (row.netProfit || 0), 0);
  console.log("\nDraw amount: %s", money(drawTotal));
  console.log("Net profit currently absorbed by these entries: %s", money(profitRecovered));

  if (candidates.length === 0) {
    console.log("\nNothing to convert. Done.");
    await mongoose.connection.close();
    return;
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN — no changes written. Re-run without DRY_RUN to apply.");
    await mongoose.connection.close();
    return;
  }

  // salesTax is zeroed alongside netProfit: a draw books no revenue, so it can
  // carry no collected tax. It should already be 0 on a Payroll record; this
  // makes the row consistent with computeAmounts regardless.
  const result = await Entry.updateMany(
    filter,
    { $set: { type: TO_TYPE, netProfit: 0, salesTax: 0 } }
  ).setOptions(ALL_ACCOUNTS);

  console.log("\nConverted: %d entries.", result.modifiedCount);

  console.log("\n=== AFTER ===");
  const after = await bookTotals();
  printTotals("books:", after);

  const converted = await Entry.find({ type: TO_TYPE })
    .setOptions(ALL_ACCOUNTS)
    .sort({ date: 1 })
    .select("date type description expense netProfit")
    .lean();
  console.log("\n%s entries (%d):", TO_TYPE, converted.length);
  printEntries(converted);

  console.log(
    "\nNet profit moved %s -> %s (recovered %s).",
    money(before.netProfit),
    money(after.netProfit),
    money(after.netProfit - before.netProfit)
  );
  console.log(
    "Cash out is unchanged: expense total is still %s, now split as %s expenses + %s owner draws.",
    money(after.expense),
    money(after.expense - after.ownerDraws),
    money(after.ownerDraws)
  );

  await mongoose.connection.close();
  console.log("\nDone.");
}

main().catch(async (err) => {
  console.error("Migration failed:", err?.message || err);
  try {
    await mongoose.connection.close();
  } catch {
    /* ignore */
  }
  process.exit(1);
});
