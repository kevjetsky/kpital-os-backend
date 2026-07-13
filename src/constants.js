export const SALES_TAX_RATE = 0.0825;
export const ENTRY_TYPES = ["Repair", "Sales", "Expenses", "Tip"];
export const TAX_EXEMPT_ENTRY_TYPES = ["Tip"];
// "Parts" was removed: parts are inventory and hit the books as COGS at the
// moment they're consumed on a repair/sale (see inventory usage), so a separate
// Parts expense line would double-count. "Tools & Equipment" covers gear that is
// simply an expense the day it's bought (screwdrivers, heat gun, etc.).
export const EXPENSE_CATEGORIES = ["Rent", "Tools & Equipment", "Marketing", "Utilities", "Payroll", "Other"];
export const ENTRY_STATUSES = ["Pending", "Completed", "Paid"];
export const PAYMENT_METHODS = ["Cash", "Card", "Zelle", "Cash App", "Chime", "PayPal", "Venmo", "Apple Pay", "Other"];
// Entry types that represent customer-facing work and therefore require a
// reachable customer (phone or Instagram) on every record.
export const CUSTOMER_REQUIRED_ENTRY_TYPES = ["Repair", "Sales"];
export const REFERENCE_OPTION_KINDS = ["customer", "product_service"];
export const PRODUCT_SERVICE_TYPES = ["product", "service"];
export const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "kpital_token";
export const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;
