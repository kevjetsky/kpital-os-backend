// How a record is tied to a saved customer or catalog item, and what it still
// owes. Mirrors the dashboard's own rules (frontend lib/customer-match.ts,
// lib/b2b.ts and hooks/useDashboardAnalytics.ts), so the numbers the server
// works out read the same as the ones the phone used to.

/** Digits only, without a leading US country code. */
export function phoneKey(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

export const handleKey = (value) => String(value || "").trim().toLowerCase().replace(/^@+/, "");
export const textKey = (value) => String(value || "").trim().toLowerCase();
const idOf = (value) => (value ? String(value) : "");

/**
 * A record with any way to reach the customer is matched on that. Only a record
 * with none falls back to its name, so two customers who share a name do not
 * share a history.
 */
export function matchesByNameOnly(entry) {
  return !entry.customerOptionId && !phoneKey(entry.customerPhone) && !handleKey(entry.customerInstagram) && !textKey(entry.customerEmail);
}

export function matchesCustomer(entry, customer) {
  if (entry.customerOptionId && idOf(entry.customerOptionId) === idOf(customer._id)) return true;
  const same = (a, b) => Boolean(a && b && a === b);
  if (same(textKey(entry.customerEmail), textKey(customer.email))) return true;
  if (same(phoneKey(entry.customerPhone), phoneKey(customer.phone))) return true;
  if (same(handleKey(entry.customerInstagram), handleKey(customer.instagram))) return true;
  return matchesByNameOnly(entry) && same(textKey(entry.customerName), textKey(customer.name));
}

/** What a record charged for, line by line. One from before line items is one line. */
export function chargedLines(entry) {
  if (Array.isArray(entry.items) && entry.items.length > 0) {
    return entry.items.map((item) => ({
      optionId: idOf(item.productServiceOptionId),
      name: item.name,
      type: item.optionType,
      amount: (item.quantity || 0) * (item.unitPrice || 0)
    }));
  }
  return [{ optionId: idOf(entry.productServiceOptionId), name: entry.productServiceName, type: entry.productServiceType, amount: entry.income || 0 }];
}

export function lineMatches(line, item) {
  if (line.optionId && line.optionId === idOf(item._id)) return true;
  const lineName = textKey(line.name);
  const itemName = textKey(item.name);
  if (!lineName || !itemName || lineName !== itemName) return false;
  // A blank type on either side is treated as compatible.
  const lineType = textKey(line.type);
  const itemType = textKey(item.optionType);
  return !lineType || !itemType || lineType === itemType;
}

export const matchesProductService = (entry, item) => chargedLines(entry).some((line) => lineMatches(line, item));

export function unpaidAmount(entry) {
  if (entry.type === "Refund" || entry.status === "Paid") return 0;
  const paid = (entry.payments || []).reduce((sum, payment) => sum + (payment.amount || 0), 0);
  return Math.max(0, (entry.income || 0) + (entry.salesTax || 0) - paid);
}

const dayOf = (value) => (value ? new Date(value).toISOString().slice(0, 10) : "");

/** Past its due date with money still owed, on a YYYY-MM-DD day. */
export function isOverdue(entry, onDay) {
  const due = dayOf(entry.dueDate);
  return Boolean(due && due < onDay && unpaidAmount(entry) > 0);
}
