export const SALES_TAX_RATE = 0.0825;
export const ENTRY_TYPES = ["Sales", "Repair", "Expenses", "Refund", "Payroll", "Owner Draw"];
// A refund hands back the price that was booked as income along with the sales
// tax charged on top of it: salesTax goes negative at the current
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
// "Payroll" was removed too — it's its own entry type now. "Shipping" is what a
// parts order costs to deliver.
export const EXPENSE_CATEGORIES = ["Rent", "Gas", "Tools & Equipment", "Marketing", "Utilities", "Shipping", "Other"];
export const ENTRY_STATUSES = ["Pending", "Completed", "Paid"];
// Where the work itself stands, apart from whether it has been paid for.
// `status` above is kept in step for older callers: Paid when paid, otherwise
// Completed once the job is Ready or Done, otherwise Pending.
export const JOB_STATUSES = ["Booked", "In progress", "Ready", "Done"];
// The work is finished: the warranty starts and the legacy status is Completed.
export const FINISHED_JOB_STATUSES = ["Ready", "Done"];
// Records billed to a customer. They get a sequential invoice number.
export const INVOICED_ENTRY_TYPES = ["Sales", "Repair", "Refund"];
// Records that can be broken into line items (several services or products).
export const LINE_ITEM_ENTRY_TYPES = ["Sales", "Repair"];
export const MAX_LINE_ITEMS = 30;
export const PAYMENT_METHODS = ["Cash", "Card", "Zelle", "Cash App", "Chime", "PayPal", "Venmo", "Apple Pay", "Other"];
// Entry types that represent customer-facing work and therefore require a
// reachable customer (phone or Instagram) on every record.
export const CUSTOMER_REQUIRED_ENTRY_TYPES = ["Repair", "Sales"];
export const REFERENCE_OPTION_KINDS = ["customer", "product_service", "business"];
// Entry types that can be marked B2B (sold to, or refunded to, a saved business).
// Money-out types other than a refund have no buyer, so the flag is dropped on them.
export const B2B_ENTRY_TYPES = ["Sales", "Repair", "Refund"];
// Longest payment terms a business can be given, in days. 0 means no terms:
// the record has no due date and is never flagged overdue.
export const MAX_PAYMENT_TERMS_DAYS = 365;
// How far ahead a tax-exempt certificate's expiry starts being flagged.
export const CERT_EXPIRY_WARNING_DAYS = 30;
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
