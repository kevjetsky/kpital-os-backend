import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { ReferenceOption } from "./models/ReferenceOption.js";
import { Settings } from "./models/Settings.js";
import {
  SALES_TAX_RATE,
  TAX_EXEMPT_ENTRY_TYPES,
  PRODUCT_SERVICE_TYPES,
  ENTRY_STATUSES,
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

export function issueAuthToken() {
  return jwt.sign({ role: "owner" }, process.env.JWT_SECRET, {
    expiresIn: "7d"
  });
}

export function computeAmounts(income, expense, type = "") {
  const safeIncome = Number.isFinite(income) ? income : 0;
  const safeExpense = Number.isFinite(expense) ? expense : 0;
  const taxExempt = TAX_EXEMPT_ENTRY_TYPES.includes(type);
  const salesTax = taxExempt ? 0 : roundMoney(safeIncome * SALES_TAX_RATE);
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
      email: option.email || "",
      address: formattedAddress || option.address || "",
      addressLine1,
      addressLine2,
      city,
      state,
      postalCode,
      reference: option.reference || "",
      notes: option.notes || ""
    };
  }

  return {
    _id: String(option._id),
    name: option.name,
    optionType: toProductServiceType(option.optionType),
    price: roundMoney(option.price || 0),
    cost: roundMoney(option.cost || 0)
  };
}

export async function resolveReferenceOption(kind, rawOptionId) {
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

  const option = await ReferenceOption.findOne({ _id: parsed, kind }).lean();
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

  return {
    httpOnly: true,
    sameSite: cookieSameSite,
    secure
  };
}

export function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...getAuthCookieOptions(),
    maxAge: COOKIE_MAX_AGE_MS
  });
}

export async function getMainSettings() {
  return Settings.findOne({ key: "main" });
}

export function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
