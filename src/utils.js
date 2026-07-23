import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { ReferenceOption } from "./models/ReferenceOption.js";
import { Settings } from "./models/Settings.js";
import {
  SALES_TAX_RATE,
  TAX_EXEMPT_ENTRY_TYPES,
  PRODUCT_SERVICE_TYPES,
  ENTRY_STATUSES,
  PAYMENT_METHODS,
  AUTH_COOKIE_NAME,
  COOKIE_MAX_AGE_MS
} from "./constants.js";

export function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = header.slice(7).trim();
  return token || null;
}

// req.accountId is a string (it comes out of the JWT). find()/updateOne() cast
// it against the schema automatically, but aggregate() does NOT — a raw string
// in a $match silently matches nothing. Always wrap it for aggregation stages.
export function toAccountObjectId(accountId) {
  if (!accountId) throw new Error("An accountId is required.");
  return accountId instanceof mongoose.Types.ObjectId
    ? accountId
    : new mongoose.Types.ObjectId(String(accountId));
}

// The token carries the account it belongs to; requireAuth turns that into
// req.accountId, which every query scopes on. Tokens issued before tenancy have
// no accountId and are rejected, forcing a re-login.
export function issueAuthToken(accountId) {
  if (!accountId) throw new Error("issueAuthToken requires an accountId.");
  return jwt.sign({ role: "owner", accountId: String(accountId) }, process.env.JWT_SECRET, {
    expiresIn: "7d"
  });
}

export function computeAmounts(income, expense, type = "", taxRate) {
  const safeIncome = Number.isFinite(income) ? income : 0;
  const safeExpense = Number.isFinite(expense) ? expense : 0;
  const rate = (Number.isFinite(taxRate) && taxRate >= 0 && taxRate <= 1) ? taxRate : SALES_TAX_RATE;
  const taxExempt = TAX_EXEMPT_ENTRY_TYPES.includes(type);
  const salesTax = taxExempt ? 0 : roundMoney(safeIncome * rate);
  const netProfit = roundMoney(safeIncome - safeExpense - salesTax);

  return {
    income: roundMoney(safeIncome),
    expense: roundMoney(safeExpense),
    salesTax,
    netProfit
  };
}

export function parseOptionalObjectId(rawValue) {
  if (rawValue === undefined) {
    return undefined;
  }

  if (rawValue === null || String(rawValue).trim() === "") {
    return null;
  }

  const value = String(rawValue).trim();
  if (!mongoose.Types.ObjectId.isValid(value)) {
    return "invalid";
  }

  return value;
}

export function normalizeOptionName(name) {
  return String(name || "").trim().toLowerCase();
}

export function normalizeAddressField(value) {
  return String(value || "").trim();
}

// Digits-only key used to match phone numbers regardless of formatting.
// A leading US country code is dropped so "+1 (555) 123-4567" matches "5551234567".
export function normalizePhoneKey(value) {
  const digits = String(value || "").replace(/\D+/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

// Canonical Instagram handle: lowercase, no leading @, profile URLs unwrapped.
export function normalizeInstagramHandle(value) {
  let handle = String(value || "").trim().toLowerCase();
  handle = handle.replace(/^(https?:\/\/)?(www\.)?instagram\.com\//, "");
  handle = handle.replace(/^@+/, "");
  handle = handle.split(/[/?#\s]/)[0];
  return handle;
}

export function toPaymentMethod(value) {
  const key = String(value || "").trim().toLowerCase().replace(/[\s_-]+/g, "");
  if (!key) return "";
  return PAYMENT_METHODS.find((method) => method.toLowerCase().replace(/\s+/g, "") === key) || "";
}

// Customers are identified by phone or Instagram; the name is only a label.
// When no name is given, fall back to whichever identifier exists.
export function deriveCustomerName(name, phone, instagram) {
  const trimmedName = String(name || "").trim();
  if (trimmedName) return trimmedName;
  const trimmedPhone = String(phone || "").trim();
  if (trimmedPhone) return trimmedPhone;
  const handle = normalizeInstagramHandle(instagram);
  return handle ? `@${handle}` : "";
}

// Finds an existing customer whose phone or Instagram matches the given
// contact info. Matching is done in memory with normalized keys so legacy
// records with formatted phone numbers still match.
export async function findCustomerByContact(accountId, phone, instagram, excludeId = null) {
  const phoneKey = normalizePhoneKey(phone);
  const instagramKey = normalizeInstagramHandle(instagram);
  if (!phoneKey && !instagramKey) return null;

  const directFilters = [];
  if (phoneKey) directFilters.push({ phoneKey });
  if (instagramKey) directFilters.push({ instagramKey });
  const direct = await ReferenceOption.findOne({
    accountId,
    kind: "customer",
    ...(excludeId ? { _id: { $ne: excludeId } } : {}),
    $or: directFilters
  }).lean();
  if (direct) return direct;

  // Compatibility fallback for customers created before normalized keys were
  // introduced. Updated records are backfilled and use the indexed path.
  const customers = await ReferenceOption.find({ accountId, kind: "customer" }).lean();
  return (
    customers.find((customer) => {
      if (excludeId && String(customer._id) === String(excludeId)) return false;
      const candidatePhone = normalizePhoneKey(customer.phone);
      const candidateInstagram = normalizeInstagramHandle(customer.instagram);
      if (phoneKey && candidatePhone && candidatePhone === phoneKey) return true;
      if (instagramKey && candidateInstagram && candidateInstagram === instagramKey) return true;
      return false;
    }) || null
  );
}

export function formatCustomerAddress(parts) {
  const line1 = normalizeAddressField(parts.addressLine1);
  const line2 = normalizeAddressField(parts.addressLine2);
  const city = normalizeAddressField(parts.city);
  const state = normalizeAddressField(parts.state);
  const postalCode = normalizeAddressField(parts.postalCode);

  const street = [line1, line2].filter(Boolean).join(", ");
  const locality = [city, [state, postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

  return [street, locality].filter(Boolean).join(", ");
}

export function toProductServiceType(value) {
  const next = String(value || "").trim().toLowerCase();
  return PRODUCT_SERVICE_TYPES.includes(next) ? next : "";
}

export function toStatus(value) {
  const next = String(value || "").trim();
  return ENTRY_STATUSES.includes(next) ? next : "";
}

export function parseMoneyInput(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { value: null, error: `${fieldName} must be a non-negative number.` };
  }
  return { value: roundMoney(parsed), error: null };
}

export function parsePaginationValue(rawValue, fallback) {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

export function serializeReferenceOption(option) {
  if (option.kind === "customer") {
    const addressLine1 = option.addressLine1 || "";
    const addressLine2 = option.addressLine2 || "";
    const city = option.city || "";
    const state = option.state || "";
    const postalCode = option.postalCode || "";
    const formattedAddress = formatCustomerAddress({ addressLine1, addressLine2, city, state, postalCode });

    return {
      _id: String(option._id),
      name: option.name,
      phone: option.phone || "",
      instagram: option.instagram || "",
      email: option.email || "",
      address: formattedAddress || option.address || "",
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      reference: option.reference || "",
      notes: option.notes || "",
      // Surfaced so detail screens can show audit timestamps. Mongoose sets
      // these via `timestamps: true`; documents created before that may lack
      // them, hence the null fallback.
      createdAt: option.createdAt || null,
      updatedAt: option.updatedAt || null
    };
  }

  return {
    _id: String(option._id),
    name: option.name,
    optionType: toProductServiceType(option.optionType),
    price: roundMoney(option.price || 0),
    cost: roundMoney(option.cost || 0),
    createdAt: option.createdAt || null,
    updatedAt: option.updatedAt || null
  };
}

export async function resolveReferenceOption(accountId, kind, rawOptionId) {
  const parsed = parseOptionalObjectId(rawOptionId);
  if (parsed === undefined) {
    return { optionId: undefined, option: undefined, error: null };
  }

  if (parsed === "invalid") {
    return { optionId: null, option: null, error: "Invalid reference option id." };
  }

  if (parsed === null) {
    return { optionId: null, option: null, error: null };
  }

  const option = await ReferenceOption.findOne({ _id: parsed, accountId, kind }).lean();
  if (!option) {
    return { optionId: null, option: null, error: "Reference option not found." };
  }

  return { optionId: String(option._id), option, error: null };
}

export function getAuthCookieOptions() {
  const sameSite = String(process.env.COOKIE_SAME_SITE || "lax").toLowerCase();
  const cookieSameSite = ["strict", "lax", "none"].includes(sameSite) ? sameSite : "lax";

  const secureFromEnv = process.env.COOKIE_SECURE;
  const secure =
    secureFromEnv === undefined
      ? process.env.NODE_ENV === "production"
      : String(secureFromEnv).toLowerCase() === "true";

  const options = {
    httpOnly: true,
    sameSite: cookieSameSite,
    secure
  };

  // When the API and the app live on sibling subdomains (e.g. api.kpitaltech.com
  // and os.kpitaltech.com), scope the cookie to the shared parent domain so it is
  // first-party for the whole site. Leave COOKIE_DOMAIN unset for a host-only
  // cookie (single-host or same-origin-proxy setups).
  const domain = String(process.env.COOKIE_DOMAIN || "").trim();
  if (domain) {
    options.domain = domain;
  }

  return options;
}

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...getAuthCookieOptions(),
    maxAge: COOKIE_MAX_AGE_MS
  });
}

// Login email, normalized. Addresses are matched case-insensitively so
// "Kevin@x.com" and "kevin@x.com" cannot become two separate accounts.
export function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

// Resolves the account a login attempt refers to. This replaced the
// single-account getMainSettings() lookup: with multiple businesses, the email
// is the only thing that identifies which account is being authenticated.
export async function findAccountByEmail(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return null;
  return Settings.findOne({ email: normalized });
}

export async function getAccountById(accountId) {
  if (!accountId) return null;
  return Settings.findById(accountId);
}

// The bootstrap account from before multi-tenancy. Only the setup/status paths
// still need it, to decide whether this deployment has been initialised at all.
export async function getMainSettings() {
  return Settings.findOne({ key: "main" });
}

export async function countAccounts() {
  return Settings.countDocuments({});
}

export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export async function withTransaction(work) {
  const session = await mongoose.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
