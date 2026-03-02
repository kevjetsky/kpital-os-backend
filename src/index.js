import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import { Settings } from "./models/Settings.js";
import { Entry } from "./models/Entry.js";
import { ReferenceOption } from "./models/ReferenceOption.js";
import { requireAuth } from "./middleware/auth.js";

const app = express();
const port = Number(process.env.PORT || 4000);
const clientOrigin = process.env.CLIENT_ORIGIN || "http://localhost:3000";
const SALES_TAX_RATE = 0.0825;
const ENTRY_TYPES = ["Repair", "Sales", "Expenses"];
const ENTRY_STATUSES = ["Pending", "Completed", "Paid"];
const REFERENCE_OPTION_KINDS = ["customer", "product_service"];
const PRODUCT_SERVICE_TYPES = ["product", "service"];
const AUTH_COOKIE_NAME = process.env.AUTH_COOKIE_NAME || "kpital_token";
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 200;

if (!process.env.JWT_SECRET) {
  throw new Error("JWT_SECRET is required");
}

app.use(
  cors({
    origin: clientOrigin,
    credentials: true
  })
);
app.use(express.json());
app.use(cookieParser());

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function roundMoney(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function getBearerToken(req) {
  const header = req.headers.authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return null;
  }

  const token = header.slice(7).trim();
  return token || null;
}

function issueAuthToken() {
  return jwt.sign({ role: "owner" }, process.env.JWT_SECRET, {
    expiresIn: "7d"
  });
}

function computeAmounts(income, expense) {
  const safeIncome = Number.isFinite(income) ? income : 0;
  const safeExpense = Number.isFinite(expense) ? expense : 0;
  const salesTax = roundMoney(safeIncome * SALES_TAX_RATE);
  const netProfit = roundMoney(safeIncome - safeExpense - salesTax);

  return {
    income: roundMoney(safeIncome),
    expense: roundMoney(safeExpense),
    salesTax,
    netProfit
  };
}

function parseOptionalObjectId(rawValue) {
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

function normalizeOptionName(name) {
  return String(name || "").trim().toLowerCase();
}

function normalizeAddressField(value) {
  return String(value || "").trim();
}

function formatCustomerAddress(parts) {
  const line1 = normalizeAddressField(parts.addressLine1);
  const line2 = normalizeAddressField(parts.addressLine2);
  const city = normalizeAddressField(parts.city);
  const state = normalizeAddressField(parts.state);
  const postalCode = normalizeAddressField(parts.postalCode);

  const street = [line1, line2].filter(Boolean).join(", ");
  const locality = [city, [state, postalCode].filter(Boolean).join(" ")].filter(Boolean).join(", ");

  return [street, locality].filter(Boolean).join(", ");
}

function toProductServiceType(value) {
  const next = String(value || "").trim().toLowerCase();
  return PRODUCT_SERVICE_TYPES.includes(next) ? next : "";
}

function toStatus(value) {
  const next = String(value || "").trim();
  return ENTRY_STATUSES.includes(next) ? next : "";
}

function parseMoneyInput(value, fieldName) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return { value: null, error: `${fieldName} must be a non-negative number.` };
  }
  return { value: roundMoney(parsed), error: null };
}

function parsePaginationValue(rawValue, fallback) {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(String(rawValue), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return null;
  }

  return parsed;
}

function serializeReferenceOption(option) {
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
      reference: option.reference || ""
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

async function resolveReferenceOption(kind, rawOptionId) {
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

function getAuthCookieOptions() {
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

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE_NAME, token, {
    ...getAuthCookieOptions(),
    maxAge: COOKIE_MAX_AGE_MS
  });
}

async function getMainSettings() {
  return Settings.findOne({ key: "main" });
}

app.get("/api/health", (_, res) => {
  res.json({ ok: true });
});

app.get("/api/auth/status", asyncHandler(async (req, res) => {
  const settings = await getMainSettings();
  const requiresSetup = !settings;

  if (requiresSetup) {
    return res.json({ requiresSetup: true, authenticated: false });
  }

  const token = getBearerToken(req) || req.cookies[AUTH_COOKIE_NAME];
  if (!token) {
    return res.json({ requiresSetup: false, authenticated: false });
  }

  try {
    jwt.verify(token, process.env.JWT_SECRET);
    return res.json({ requiresSetup: false, authenticated: true });
  } catch {
    return res.json({ requiresSetup: false, authenticated: false });
  }
}));

app.post("/api/auth/setup", asyncHandler(async (req, res) => {
  const { password } = req.body ?? {};
  if (!password || String(password).length < 4) {
    return res.status(400).json({ message: "Password must be at least 4 characters." });
  }

  const existing = await getMainSettings();
  if (existing) {
    return res.status(409).json({ message: "Password already set." });
  }

  const passwordHash = await bcrypt.hash(String(password), 10);
  await Settings.create({ key: "main", passwordHash });
  const token = issueAuthToken();
  setAuthCookie(res, token);

  return res.status(201).json({ ok: true, token });
}));

app.post("/api/auth/login", asyncHandler(async (req, res) => {
  const { password } = req.body ?? {};

  const settings = await getMainSettings();
  if (!settings) {
    return res.status(400).json({ message: "Run initial setup first." });
  }

  const isValid = await bcrypt.compare(String(password || ""), settings.passwordHash);
  if (!isValid) {
    return res.status(401).json({ message: "Invalid password." });
  }

  const token = issueAuthToken();
  setAuthCookie(res, token);
  return res.json({ ok: true, token });
}));

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(AUTH_COOKIE_NAME, getAuthCookieOptions());
  res.json({ ok: true });
});

app.get("/api/reference-options", requireAuth, asyncHandler(async (_req, res) => {
  const options = await ReferenceOption.find({}).sort({ kind: 1, name: 1 }).lean();
  const customers = [];
  const productServices = [];

  options.forEach((option) => {
    if (option.kind === "customer") {
      customers.push(serializeReferenceOption(option));
      return;
    }

    if (option.kind === "product_service") {
      productServices.push(serializeReferenceOption(option));
    }
  });

  res.json({ customers, productServices });
}));

app.post("/api/reference-options", requireAuth, asyncHandler(async (req, res) => {
  const kind = String(req.body?.kind || "").trim();
  if (!REFERENCE_OPTION_KINDS.includes(kind)) {
    return res.status(400).json({ message: "Kind must be customer or product_service." });
  }

  const name = String(req.body?.name || "").trim();
  if (!name) {
    return res.status(400).json({ message: "Name is required." });
  }

  const normalizedName = normalizeOptionName(name);

  const payload = {
    kind,
    name,
    normalizedName,
    phone: "",
    email: "",
    address: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    state: "",
    postalCode: "",
    reference: "",
    optionType: "",
    price: 0,
    cost: 0
  };

  if (kind === "customer") {
    const phone = String(req.body?.phone || "").trim();
    const email = String(req.body?.email || "").trim();
    const reference = String(req.body?.reference || "").trim();
    const addressLine1 = normalizeAddressField(req.body?.addressLine1);
    const addressLine2 = normalizeAddressField(req.body?.addressLine2);
    const city = normalizeAddressField(req.body?.city);
    const state = normalizeAddressField(req.body?.state);
    const postalCode = normalizeAddressField(req.body?.postalCode);
    const formattedAddress = formatCustomerAddress({ addressLine1, addressLine2, city, state, postalCode });
    const legacyAddress = String(req.body?.address || "").trim();

    payload.phone = phone;
    payload.email = email;
    payload.address = formattedAddress || legacyAddress;
    payload.addressLine1 = addressLine1;
    payload.addressLine2 = addressLine2;
    payload.city = city;
    payload.state = state;
    payload.postalCode = postalCode;
    payload.reference = reference;
  }

  if (kind === "product_service") {
    const optionType = toProductServiceType(req.body?.optionType);
    if (!optionType) {
      return res.status(400).json({ message: "Product/service type must be product or service." });
    }

    const parsedPrice = parseMoneyInput(req.body?.price, "Price");
    if (parsedPrice.error) {
      return res.status(400).json({ message: parsedPrice.error });
    }
    const parsedCost = parseMoneyInput(req.body?.cost ?? 0, "Cost");
    if (parsedCost.error) {
      return res.status(400).json({ message: parsedCost.error });
    }

    payload.optionType = optionType;
    payload.price = parsedPrice.value;
    payload.cost = parsedCost.value;
  }

  try {
    const created = await ReferenceOption.create(payload);
    return res.status(201).json(serializeReferenceOption(created));
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "Reference option already exists." });
    }
    throw error;
  }
}));

app.put("/api/reference-options/:id", requireAuth, asyncHandler(async (req, res) => {
  const optionId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(optionId)) {
    return res.status(400).json({ message: "Invalid reference option id." });
  }

  const existing = await ReferenceOption.findById(optionId);
  if (!existing) {
    return res.status(404).json({ message: "Reference option not found." });
  }

  const hasOwn = (field) => Object.prototype.hasOwnProperty.call(req.body || {}, field);
  const name = hasOwn("name") ? String(req.body?.name || "").trim() : existing.name;
  if (!name) {
    return res.status(400).json({ message: "Name is required." });
  }

  existing.name = name;
  existing.normalizedName = normalizeOptionName(name);

  if (existing.kind === "customer") {
    const addressLine1 = hasOwn("addressLine1")
      ? normalizeAddressField(req.body?.addressLine1)
      : (existing.addressLine1 || "");
    const addressLine2 = hasOwn("addressLine2")
      ? normalizeAddressField(req.body?.addressLine2)
      : (existing.addressLine2 || "");
    const city = hasOwn("city") ? normalizeAddressField(req.body?.city) : (existing.city || "");
    const state = hasOwn("state") ? normalizeAddressField(req.body?.state) : (existing.state || "");
    const postalCode = hasOwn("postalCode")
      ? normalizeAddressField(req.body?.postalCode)
      : (existing.postalCode || "");
    const legacyAddress = hasOwn("address") ? String(req.body?.address || "").trim() : (existing.address || "");
    const formattedAddress = formatCustomerAddress({ addressLine1, addressLine2, city, state, postalCode });

    existing.phone = hasOwn("phone") ? String(req.body?.phone || "").trim() : (existing.phone || "");
    existing.email = hasOwn("email") ? String(req.body?.email || "").trim() : (existing.email || "");
    existing.reference = hasOwn("reference") ? String(req.body?.reference || "").trim() : (existing.reference || "");
    existing.addressLine1 = addressLine1;
    existing.addressLine2 = addressLine2;
    existing.city = city;
    existing.state = state;
    existing.postalCode = postalCode;
    existing.address = formattedAddress || legacyAddress;
  }

  if (existing.kind === "product_service") {
    const nextType = hasOwn("optionType")
      ? toProductServiceType(req.body?.optionType)
      : toProductServiceType(existing.optionType);
    if (!nextType) {
      return res.status(400).json({ message: "Product/service type must be product or service." });
    }
    existing.optionType = nextType;

    if (hasOwn("price")) {
      const parsedPrice = parseMoneyInput(req.body?.price, "Price");
      if (parsedPrice.error) {
        return res.status(400).json({ message: parsedPrice.error });
      }
      existing.price = parsedPrice.value;
    } else {
      existing.price = roundMoney(existing.price || 0);
    }

    if (hasOwn("cost")) {
      const parsedCost = parseMoneyInput(req.body?.cost, "Cost");
      if (parsedCost.error) {
        return res.status(400).json({ message: parsedCost.error });
      }
      existing.cost = parsedCost.value;
    } else {
      existing.cost = roundMoney(existing.cost || 0);
    }
  }

  try {
    await existing.save();
    return res.json(serializeReferenceOption(existing));
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "Reference option already exists." });
    }
    throw error;
  }
}));

app.delete("/api/reference-options/:id", requireAuth, asyncHandler(async (req, res) => {
  const optionId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(optionId)) {
    return res.status(400).json({ message: "Invalid reference option id." });
  }

  const deleted = await ReferenceOption.findByIdAndDelete(optionId);
  if (!deleted) {
    return res.status(404).json({ message: "Reference option not found." });
  }

  if (deleted.kind === "customer") {
    await Entry.updateMany(
      { customerOptionId: deleted._id },
      { $set: { customerOptionId: null } }
    );
  }

  if (deleted.kind === "product_service") {
    await Entry.updateMany(
      { productServiceOptionId: deleted._id },
      { $set: { productServiceOptionId: null } }
    );
  }

  return res.json({ ok: true });
}));

app.get("/api/entries", requireAuth, asyncHandler(async (req, res) => {
  const { type, status, page, limit } = req.query;
  const query = {};

  if (type) {
    const typeFilter = String(type);
    if (!ENTRY_TYPES.includes(typeFilter)) {
      return res.status(400).json({ message: "Type filter must be Repair, Sales, or Expenses." });
    }
    query.type = typeFilter;
  }
  if (status) {
    const statusFilter = String(status);
    if (!ENTRY_STATUSES.includes(statusFilter)) {
      return res.status(400).json({ message: "Status filter must be Pending, Completed, or Paid." });
    }
    query.status = statusFilter;
  }

  const hasPagination = page !== undefined || limit !== undefined;
  if (!hasPagination) {
    const entries = await Entry.find(query).sort({ date: -1, createdAt: -1 }).lean();
    return res.json(entries);
  }

  const parsedPage = parsePaginationValue(page, 1);
  const parsedLimit = parsePaginationValue(limit, DEFAULT_PAGE_SIZE);
  if (!parsedPage || !parsedLimit) {
    return res.status(400).json({ message: "Pagination values must be positive integers." });
  }

  const cappedLimit = Math.min(parsedLimit, MAX_PAGE_SIZE);
  const [total, entries] = await Promise.all([
    Entry.countDocuments(query),
    Entry.find(query)
      .sort({ date: -1, createdAt: -1 })
      .skip((parsedPage - 1) * cappedLimit)
      .limit(cappedLimit)
      .lean()
  ]);

  const totalPages = Math.max(1, Math.ceil(total / cappedLimit));
  return res.json({
    items: entries,
    pagination: {
      page: parsedPage,
      limit: cappedLimit,
      total,
      totalPages
    }
  });
}));

app.post("/api/entries", requireAuth, asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const type = String(body.type || "");

  if (!ENTRY_TYPES.includes(type)) {
    return res.status(400).json({ message: "Type must be Repair, Sales, or Expenses." });
  }

  const date = new Date(body.date);
  if (Number.isNaN(date.getTime())) {
    return res.status(400).json({ message: "Invalid date." });
  }

  let description = String(body.description || "").trim();

  const status = toStatus(body.status || "Pending");
  if (!status) {
    return res.status(400).json({ message: "Status must be Pending, Completed, or Paid." });
  }
  const notes = String(body.notes || "").trim();

  const parsedIncome = parseMoneyInput(body.income ?? 0, "Income");
  if (parsedIncome.error) {
    return res.status(400).json({ message: parsedIncome.error });
  }
  const parsedExpense = parseMoneyInput(body.expense ?? 0, "Expense");
  if (parsedExpense.error) {
    return res.status(400).json({ message: parsedExpense.error });
  }
  const income = parsedIncome.value;
  const expense = parsedExpense.value;

  let customerName = String(body.customerName || "").trim();
  let customerPhone = String(body.customerPhone || "").trim();
  let customerEmail = String(body.customerEmail || "").trim();
  let customerAddress = String(body.customerAddress || "").trim();
  let customerReferenceLabel = String(body.customerReference || "").trim();
  let customerOptionId = null;

  let productServiceName = String(body.productServiceName || "").trim();
  let productServiceType = toProductServiceType(body.productServiceType);
  const parsedProductPrice = parseMoneyInput(body.productServicePrice ?? 0, "Product/service price");
  if (parsedProductPrice.error) {
    return res.status(400).json({ message: parsedProductPrice.error });
  }
  let productServicePrice = parsedProductPrice.value;
  let productServiceOptionId = null;

  const customerRefOption = await resolveReferenceOption("customer", body.customerOptionId);
  if (customerRefOption.error) {
    return res.status(400).json({ message: customerRefOption.error });
  }
  if (customerRefOption.option) {
    customerName = customerRefOption.option.name;
    customerPhone = customerRefOption.option.phone || "";
    customerEmail = customerRefOption.option.email || "";
    customerAddress = customerRefOption.option.address || "";
    customerReferenceLabel = customerRefOption.option.reference || "";
    customerOptionId = customerRefOption.optionId;
  }

  const productServiceReference = await resolveReferenceOption("product_service", body.productServiceOptionId);
  if (productServiceReference.error) {
    return res.status(400).json({ message: productServiceReference.error });
  }
  if (productServiceReference.option) {
    productServiceName = productServiceReference.option.name;
    productServiceType = toProductServiceType(productServiceReference.option.optionType);
    productServicePrice = roundMoney(productServiceReference.option.price || 0);
    productServiceOptionId = productServiceReference.optionId;
  }

  if (!customerName) {
    customerPhone = "";
    customerEmail = "";
    customerAddress = "";
    customerReferenceLabel = "";
    customerOptionId = null;
  }

  if (!productServiceName) {
    productServiceType = "";
    productServicePrice = 0;
    productServiceOptionId = null;
  }

  if (!description && !productServiceName) {
    return res.status(400).json({ message: "Description is required when no product/service is selected." });
  }

  const amounts = computeAmounts(income, expense);

  const entry = await Entry.create({
    date,
    type,
    description,
    customerName,
    customerPhone,
    customerEmail,
    customerAddress,
    customerReference: customerReferenceLabel,
    customerOptionId,
    productServiceName,
    productServiceType,
    productServicePrice,
    productServiceOptionId,
    ...amounts,
    notes,
    status
  });

  return res.status(201).json(entry);
}));

app.put("/api/entries/:id", requireAuth, asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }

  const existing = await Entry.findById(entryId);
  if (!existing) {
    return res.status(404).json({ message: "Entry not found." });
  }

  const type = req.body.type ? String(req.body.type) : existing.type;
  if (!ENTRY_TYPES.includes(type)) {
    return res.status(400).json({ message: "Type must be Repair, Sales, or Expenses." });
  }

  const date = req.body.date ? new Date(req.body.date) : existing.date;
  if (Number.isNaN(date.getTime())) {
    return res.status(400).json({ message: "Invalid date." });
  }

  let description = existing.description || "";
  if (Object.prototype.hasOwnProperty.call(req.body, "description")) {
    description = String(req.body.description || "").trim();
  }

  const parsedIncome = req.body.income !== undefined
    ? parseMoneyInput(req.body.income, "Income")
    : { value: existing.income, error: null };
  if (parsedIncome.error) {
    return res.status(400).json({ message: parsedIncome.error });
  }

  const parsedExpense = req.body.expense !== undefined
    ? parseMoneyInput(req.body.expense, "Expense")
    : { value: existing.expense, error: null };
  if (parsedExpense.error) {
    return res.status(400).json({ message: parsedExpense.error });
  }

  const income = parsedIncome.value;
  const expense = parsedExpense.value;
  const status = req.body.status !== undefined ? toStatus(req.body.status) : existing.status;
  if (!status) {
    return res.status(400).json({ message: "Status must be Pending, Completed, or Paid." });
  }
  const notes = req.body.notes !== undefined ? String(req.body.notes).trim() : existing.notes;

  let customerName = existing.customerName || "";
  let customerPhone = existing.customerPhone || "";
  let customerEmail = existing.customerEmail || "";
  let customerAddress = existing.customerAddress || "";
  let customerReferenceLabel = existing.customerReference || "";
  let customerOptionId = existing.customerOptionId ? String(existing.customerOptionId) : null;

  let productServiceName = existing.productServiceName || "";
  let productServiceType = toProductServiceType(existing.productServiceType);
  let productServicePrice = Number.isFinite(existing.productServicePrice) ? existing.productServicePrice : 0;
  let productServiceOptionId = existing.productServiceOptionId ? String(existing.productServiceOptionId) : null;

  if (Object.prototype.hasOwnProperty.call(req.body, "customerName")) {
    customerName = String(req.body.customerName || "").trim();
    if (!Object.prototype.hasOwnProperty.call(req.body, "customerOptionId")) {
      customerOptionId = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "customerPhone")) {
    customerPhone = String(req.body.customerPhone || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "customerEmail")) {
    customerEmail = String(req.body.customerEmail || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "customerAddress")) {
    customerAddress = String(req.body.customerAddress || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "customerReference")) {
    customerReferenceLabel = String(req.body.customerReference || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "productServiceName")) {
    productServiceName = String(req.body.productServiceName || "").trim();
    if (!Object.prototype.hasOwnProperty.call(req.body, "productServiceOptionId")) {
      productServiceOptionId = null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "productServiceType")) {
    productServiceType = toProductServiceType(req.body.productServiceType);
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "productServicePrice")) {
    const parsedPrice = parseMoneyInput(req.body.productServicePrice, "Product/service price");
    if (parsedPrice.error) {
      return res.status(400).json({ message: parsedPrice.error });
    }
    productServicePrice = parsedPrice.value;
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "customerOptionId")) {
    const customerRefOption = await resolveReferenceOption("customer", req.body.customerOptionId);
    if (customerRefOption.error) {
      return res.status(400).json({ message: customerRefOption.error });
    }

    if (!customerRefOption.option) {
      customerOptionId = null;
      if (!Object.prototype.hasOwnProperty.call(req.body, "customerName")) {
        customerName = "";
      }
      if (!Object.prototype.hasOwnProperty.call(req.body, "customerPhone")) {
        customerPhone = "";
      }
      if (!Object.prototype.hasOwnProperty.call(req.body, "customerEmail")) {
        customerEmail = "";
      }
      if (!Object.prototype.hasOwnProperty.call(req.body, "customerAddress")) {
        customerAddress = "";
      }
      if (!Object.prototype.hasOwnProperty.call(req.body, "customerReference")) {
        customerReferenceLabel = "";
      }
    } else {
      customerOptionId = customerRefOption.optionId;
      customerName = customerRefOption.option.name;
      customerPhone = customerRefOption.option.phone || "";
      customerEmail = customerRefOption.option.email || "";
      customerAddress = customerRefOption.option.address || "";
      customerReferenceLabel = customerRefOption.option.reference || "";
    }
  }

  if (Object.prototype.hasOwnProperty.call(req.body, "productServiceOptionId")) {
    const productServiceReference = await resolveReferenceOption("product_service", req.body.productServiceOptionId);
    if (productServiceReference.error) {
      return res.status(400).json({ message: productServiceReference.error });
    }

    if (!productServiceReference.option) {
      productServiceOptionId = null;
      if (!Object.prototype.hasOwnProperty.call(req.body, "productServiceName")) {
        productServiceName = "";
      }
      if (!Object.prototype.hasOwnProperty.call(req.body, "productServiceType")) {
        productServiceType = "";
      }
      if (!Object.prototype.hasOwnProperty.call(req.body, "productServicePrice")) {
        productServicePrice = 0;
      }
    } else {
      productServiceOptionId = productServiceReference.optionId;
      productServiceName = productServiceReference.option.name;
      productServiceType = toProductServiceType(productServiceReference.option.optionType);
      productServicePrice = roundMoney(productServiceReference.option.price || 0);
    }
  }

  if (!customerName) {
    customerPhone = "";
    customerEmail = "";
    customerAddress = "";
    customerReferenceLabel = "";
    customerOptionId = null;
  }

  if (!productServiceName) {
    productServiceType = "";
    productServicePrice = 0;
    productServiceOptionId = null;
  }

  if (!description && !productServiceName) {
    return res.status(400).json({ message: "Description is required when no product/service is selected." });
  }

  const amounts = computeAmounts(income, expense);

  existing.date = date;
  existing.type = type;
  existing.description = description;
  existing.income = amounts.income;
  existing.expense = amounts.expense;
  existing.salesTax = amounts.salesTax;
  existing.netProfit = amounts.netProfit;
  existing.customerName = customerName;
  existing.customerPhone = customerPhone;
  existing.customerEmail = customerEmail;
  existing.customerAddress = customerAddress;
  existing.customerReference = customerReferenceLabel;
  existing.customerOptionId = customerOptionId;
  existing.productServiceName = productServiceName;
  existing.productServiceType = productServiceType;
  existing.productServicePrice = productServicePrice;
  existing.productServiceOptionId = productServiceOptionId;
  existing.status = status || "Pending";
  existing.notes = notes;

  await existing.save();
  return res.json(existing);
}));

app.delete("/api/entries/:id", requireAuth, asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }

  const deleted = await Entry.findByIdAndDelete(entryId);
  if (!deleted) {
    return res.status(404).json({ message: "Entry not found." });
  }

  return res.json({ ok: true });
}));

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ message: "Internal server error." });
});

async function start() {
  await mongoose.connect(process.env.MONGODB_URI);
  app.listen(port, () => {
    console.log(`API running on http://localhost:${port}`);
  });
}

start().catch((error) => {
  console.error("Failed to start API", error);
  process.exit(1);
});
