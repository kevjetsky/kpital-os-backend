export const SALES_TAX_RATE = 0.0825;
export const ENTRY_TYPES = ["Sales", "Repair", "Expenses", "Refund", "Payroll", "Owner Draw"];
// A refund hands back money that was booked as income with sales tax carved out
// of it, so it also hands back the tax: salesTax goes negative at the current
// rate, which nets against the quarter's collected total.
export const TAX_REVERSING_ENTRY_TYPES = ["Refund"];
// The owner taking money out of a single-member LLC is a capital distribution,
// not a deductible business expense: the cash really leaves the account (so the
// amount sits in `expense`), but it must not move net profit, or the P&L reads
// as a loss on every month the owner pays themselves. These types are dropped
// from profit and from the "total expenses" figure, and reported separately as
// owner draws so cash out still reconciles. Payroll is NOT one of these — a real
// wage to a real employee is a deductible expense.
export const PROFIT_NEUTRAL_ENTRY_TYPES = ["Owner Draw"];
// "Parts" was removed: parts are inventory and hit the books as COGS at the
// moment they're consumed on a repair/sale (see inventory usage), so a separate
// Parts expense line would double-count. "Tools & Equipment" covers gear that is
// simply an expense the day it's bought (screwdrivers, heat gun, etc.).
// "Payroll" was removed too — it's its own entry type now.
export const EXPENSE_CATEGORIES = ["Rent", "Gas", "Tools & Equipment", "Marketing", "Utilities", "Other"];
export const ENTRY_STATUSES = ["Pending", "Completed", "Paid"];
export const PAYMENT_METHODS = ["Cash", "Card", "Zelle", "Cash App", "Chime", "PayPal", "Venmo", "Apple Pay", "Other"];
// Entry types that represent customer-facing work and therefore require a
// reachable customer (phone or Instagram) on every record.
export const CUSTOMER_REQUIRED_ENTRY_TYPES = ["Repair", "Sales"];
export const REFERENCE_OPTION_KINDS = ["customer", "product_service"];
// How long after a repair a returning customer counts as a warranty callback.
export const WARRANTY_DAYS = 40;
// The message a customer gets when their repair is finished. Kept here rather
// than inline in the schema so the settings screen can offer it as a one-tap
// reset without the frontend keeping its own copy that can drift.
//
// Deliberately 150 GSM-7 characters with a real warranty code and review link
// substituted in — one segment, one charge. Lengthening it past 160 doubles the
// per-text cost, so check the segment counter in Settings before editing.
export const DEFAULT_WARRANTY_SMS_TEMPLATE =
  "Hey! {business} here. Warranty #: {warranty}.\nIf you had a good experience, a quick Google review helps a ton: {review}";
export const PRODUCT_SERVICE_TYPES = ["product", "service"];
export const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "kpital_token";
export const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
