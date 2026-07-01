// local mongod
import mongoose from "mongoose";

process.env.JWT_SECRET = "test";

const { RecurringEntry } = await import("/Users/ezpawn/Desktop/projects/Kpital OS/backend/src/models/RecurringEntry.js");
const { Entry } = await import("/Users/ezpawn/Desktop/projects/Kpital OS/backend/src/models/Entry.js");
const svc = await import("/Users/ezpawn/Desktop/projects/Kpital OS/backend/src/services/recurringService.js");


await mongoose.connect("mongodb://127.0.0.1:27017/kpital_recurring_test");
await mongoose.connection.dropDatabase();

function d(s) { return svc.startOfUtcDay(new Date(s)); }
let pass = 0, fail = 0;
function assert(cond, msg) { if (cond) { pass++; } else { fail++; console.log("  ✗", msg); } }

// 1) Monthly rent starting 3 months ago -> catch-up should post 3 (this/last/2-ago up to today) given asOf
const start = "2026-03-01";
const rent = await RecurringEntry.create({
  name: "Office Rent", type: "Expenses", category: "Rent", description: "Rent",
  income: 0, expense: 1200, status: "Paid",
  frequency: "monthly", interval: 1, startDate: d(start), nextRunDate: d(start)
});
const asOf = d("2026-06-27");
const created = await svc.postDueForRecurring(rent, asOf);
// occurrences due <= 2026-06-27: Mar 1, Apr 1, May 1, Jun 1 = 4
assert(created.length === 4, `expected 4 posted, got ${created.length}`);
const after = await RecurringEntry.findById(rent._id);
assert(svc.startOfUtcDay(after.nextRunDate).toISOString() === d("2026-07-01").toISOString(), `nextRun should be Jul 1, got ${after.nextRunDate?.toISOString()}`);
assert(after.occurrenceCount === 4, `occurrenceCount 4, got ${after.occurrenceCount}`);

// 2) Idempotency: running again with same asOf posts nothing
const again = await svc.postDueForRecurring(after, asOf);
assert(again.length === 0, `re-run should post 0, got ${again.length}`);

// 3) Entry fields correct (tax exempt? Expenses are taxed on income=0 so salesTax 0; netProfit = -1200)
const entries = await Entry.find({}).sort({ date: 1 });
assert(entries.length === 4, `4 entries total, got ${entries.length}`);
assert(entries[0].expense === 1200 && entries[0].netProfit === -1200, `entry amounts wrong: exp ${entries[0].expense} net ${entries[0].netProfit}`);
assert(entries[0].category === "Rent" && entries[0].type === "Expenses", "category/type wrong");
assert(svc.startOfUtcDay(entries[0].date).toISOString() === d("2026-03-01").toISOString(), `first entry date wrong ${entries[0].date.toISOString()}`);

// 4) Day-of-month clamping: monthly on the 31st -> Feb 28
const j = svc.advanceDate(d("2026-01-31"), "monthly", 1, 31);
assert(j.toISOString() === d("2026-02-28").toISOString(), `Jan31 +1mo should clamp to Feb28, got ${j.toISOString()}`);
const back = svc.advanceDate(j, "monthly", 1, 31);
assert(back.toISOString() === d("2026-03-31").toISOString(), `Feb28 -> should restore to Mar31 via anchor, got ${back.toISOString()}`);

// 5) endDate stops it & deactivates
const ended = await RecurringEntry.create({
  name: "Promo", type: "Sales", description: "x", income: 100, expense: 0, status: "Paid",
  frequency: "monthly", interval: 1, startDate: d("2026-01-01"), endDate: d("2026-02-15"), nextRunDate: d("2026-01-01")
});
const c2 = await svc.postDueForRecurring(ended, d("2026-06-27"));
assert(c2.length === 2, `promo should post Jan+Feb = 2, got ${c2.length}`);
const ended2 = await RecurringEntry.findById(ended._id);
assert(ended2.active === false, "promo should be deactivated after endDate");

// 6) weekly
const w = svc.advanceDate(d("2026-06-01"), "weekly", 2, 1);
assert(w.toISOString() === d("2026-06-15").toISOString(), `weekly x2 wrong ${w.toISOString()}`);

console.log(`\n${pass} passed, ${fail} failed`);
await mongoose.disconnect();

process.exit(fail ? 1 : 0);
