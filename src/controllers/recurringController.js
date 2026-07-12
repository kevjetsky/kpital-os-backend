import mongoose from "mongoose";
import { RecurringEntry } from "../models/RecurringEntry.js";
import {
  asyncHandler,
  parseMoneyInput,
  toStatus,
  toProductServiceType,
  resolveReferenceOption,
  normalizeInstagramHandle
} from "../utils.js";
import {
  advanceDate,
  startOfUtcDay,
  todayUtc,
  postDueForRecurring,
  postAllDue
} from "../services/recurringService.js";
import { ENTRY_TYPES, EXPENSE_CATEGORIES } from "../constants.js";

const FREQUENCIES = ["daily", "weekly", "monthly", "yearly"];

function bodyHas(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

// First occurrence on or after today, derived from the user's start date so a
// past start date rolls forward instead of backfilling historical entries.
function computeInitialNextRun(startDate, frequency, interval) {
  const anchorDay = startOfUtcDay(startDate).getUTCDate();
  let next = startOfUtcDay(startDate);
  const today = todayUtc();
  let guard = 0;
  while (next < today && guard < 1000) {
    next = advanceDate(next, frequency, interval, anchorDay);
    guard += 1;
  }
  return next;
}

export const list = asyncHandler(async (_req, res) => {
  const items = await RecurringEntry.find().sort({ active: -1, nextRunDate: 1 }).lean();
  return res.json(items);
});

export const create = asyncHandler(async (req, res) => {
  const body = req.body ?? {};

  const name = String(body.name || "").trim();
  if (!name) {
    return res.status(400).json({ message: "Name is required." });
  }

  const type = String(body.type || "");
  if (!ENTRY_TYPES.includes(type)) {
    return res.status(400).json({ message: "Type must be Repair, Sales, Expenses, or Tip." });
  }

  const frequency = String(body.frequency || "monthly");
  if (!FREQUENCIES.includes(frequency)) {
    return res.status(400).json({ message: "Frequency must be daily, weekly, monthly, or yearly." });
  }

  const interval = Number.parseInt(body.interval, 10);
  const safeInterval = Number.isFinite(interval) && interval >= 1 ? interval : 1;

  const startDate = startOfUtcDay(new Date(body.startDate));
  if (Number.isNaN(startDate.getTime())) {
    return res.status(400).json({ message: "Invalid start date." });
  }

  let endDate = null;
  if (body.endDate) {
    endDate = startOfUtcDay(new Date(body.endDate));
    if (Number.isNaN(endDate.getTime())) {
      return res.status(400).json({ message: "Invalid end date." });
    }
  }

  const parsedIncome = parseMoneyInput(body.income ?? 0, "Income");
  if (parsedIncome.error) return res.status(400).json({ message: parsedIncome.error });
  const parsedExpense = parseMoneyInput(body.expense ?? 0, "Expense");
  if (parsedExpense.error) return res.status(400).json({ message: parsedExpense.error });

  const status = toStatus(body.status || "Paid");
  if (!status) {
    return res.status(400).json({ message: "Status must be Pending, Completed, or Paid." });
  }

  const description = String(body.description || "").trim();
  const notes = String(body.notes || "").trim();
  const rawCategory = String(body.category || "").trim();
  const category = type === "Expenses" && EXPENSE_CATEGORIES.includes(rawCategory) ? rawCategory : "";

  let maxOccurrences = null;
  if (body.maxOccurrences !== undefined && body.maxOccurrences !== null && body.maxOccurrences !== "") {
    const parsedMax = Number.parseInt(body.maxOccurrences, 10);
    if (!Number.isFinite(parsedMax) || parsedMax < 1) {
      return res.status(400).json({ message: "Max occurrences must be a positive integer." });
    }
    maxOccurrences = parsedMax;
  }

  // Reuse reference options the same way entries do, so a recurring template can
  // point at a saved customer / product-service.
  let customerName = String(body.customerName || "").trim();
  let customerPhone = String(body.customerPhone || "").trim();
  let customerInstagram = normalizeInstagramHandle(body.customerInstagram);
  let customerEmail = String(body.customerEmail || "").trim();
  let customerAddress = String(body.customerAddress || "").trim();
  let customerReference = String(body.customerReference || "").trim();
  let customerOptionId = null;

  const customerRefOption = await resolveReferenceOption("customer", body.customerOptionId);
  if (customerRefOption.error) return res.status(400).json({ message: customerRefOption.error });
  if (customerRefOption.option) {
    customerName = customerRefOption.option.name;
    customerPhone = customerRefOption.option.phone || "";
    customerInstagram = normalizeInstagramHandle(customerRefOption.option.instagram);
    customerEmail = customerRefOption.option.email || "";
    customerAddress = customerRefOption.option.address || "";
    customerReference = customerRefOption.option.reference || "";
    customerOptionId = customerRefOption.optionId;
  }

  let productServiceName = String(body.productServiceName || "").trim();
  let productServiceType = toProductServiceType(body.productServiceType);
  const parsedProductPrice = parseMoneyInput(body.productServicePrice ?? 0, "Product/service price");
  if (parsedProductPrice.error) return res.status(400).json({ message: parsedProductPrice.error });
  let productServicePrice = parsedProductPrice.value;
  let productServiceOptionId = null;

  const productServiceRef = await resolveReferenceOption("product_service", body.productServiceOptionId);
  if (productServiceRef.error) return res.status(400).json({ message: productServiceRef.error });
  if (productServiceRef.option) {
    productServiceName = productServiceRef.option.name;
    productServiceType = toProductServiceType(productServiceRef.option.optionType);
    productServicePrice = Number(productServiceRef.option.price || 0);
    productServiceOptionId = productServiceRef.optionId;
  }

  if (!description && !productServiceName) {
    return res.status(400).json({ message: "Description is required when no product/service is selected." });
  }

  const nextRunDate = computeInitialNextRun(startDate, frequency, safeInterval);

  const recurring = await RecurringEntry.create({
    name,
    type,
    description,
    income: parsedIncome.value,
    expense: parsedExpense.value,
    category,
    notes,
    customerName,
    customerPhone,
    customerInstagram,
    customerEmail,
    customerAddress,
    customerReference,
    customerOptionId,
    productServiceName,
    productServiceType,
    productServicePrice,
    productServiceOptionId,
    status,
    frequency,
    interval: safeInterval,
    startDate,
    endDate,
    nextRunDate,
    maxOccurrences,
    active: body.active === undefined ? true : Boolean(body.active)
  });

  return res.status(201).json(recurring);
});

export const update = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid recurring entry id." });
  }

  const existing = await RecurringEntry.findById(id);
  if (!existing) {
    return res.status(404).json({ message: "Recurring entry not found." });
  }

  const body = req.body ?? {};

  if (bodyHas(body, "name")) {
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ message: "Name is required." });
    existing.name = name;
  }

  if (bodyHas(body, "type")) {
    const type = String(body.type || "");
    if (!ENTRY_TYPES.includes(type)) {
      return res.status(400).json({ message: "Type must be Repair, Sales, Expenses, or Tip." });
    }
    existing.type = type;
  }

  if (bodyHas(body, "description")) existing.description = String(body.description || "").trim();
  if (bodyHas(body, "notes")) existing.notes = String(body.notes || "").trim();

  if (bodyHas(body, "income")) {
    const parsed = parseMoneyInput(body.income, "Income");
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    existing.income = parsed.value;
  }
  if (bodyHas(body, "expense")) {
    const parsed = parseMoneyInput(body.expense, "Expense");
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    existing.expense = parsed.value;
  }

  if (bodyHas(body, "category")) {
    const rawCategory = String(body.category || "").trim();
    existing.category = existing.type === "Expenses" && EXPENSE_CATEGORIES.includes(rawCategory) ? rawCategory : "";
  }

  if (bodyHas(body, "status")) {
    const status = toStatus(body.status);
    if (!status) return res.status(400).json({ message: "Status must be Pending, Completed, or Paid." });
    existing.status = status;
  }

  if (bodyHas(body, "frequency")) {
    const frequency = String(body.frequency || "");
    if (!FREQUENCIES.includes(frequency)) {
      return res.status(400).json({ message: "Frequency must be daily, weekly, monthly, or yearly." });
    }
    existing.frequency = frequency;
  }

  if (bodyHas(body, "interval")) {
    const interval = Number.parseInt(body.interval, 10);
    existing.interval = Number.isFinite(interval) && interval >= 1 ? interval : 1;
  }

  let scheduleChanged = bodyHas(body, "frequency") || bodyHas(body, "interval");

  if (bodyHas(body, "startDate")) {
    const startDate = startOfUtcDay(new Date(body.startDate));
    if (Number.isNaN(startDate.getTime())) {
      return res.status(400).json({ message: "Invalid start date." });
    }
    existing.startDate = startDate;
    scheduleChanged = true;
  }

  if (bodyHas(body, "endDate")) {
    if (!body.endDate) {
      existing.endDate = null;
    } else {
      const endDate = startOfUtcDay(new Date(body.endDate));
      if (Number.isNaN(endDate.getTime())) {
        return res.status(400).json({ message: "Invalid end date." });
      }
      existing.endDate = endDate;
    }
  }

  if (bodyHas(body, "maxOccurrences")) {
    if (body.maxOccurrences === null || body.maxOccurrences === "") {
      existing.maxOccurrences = null;
    } else {
      const parsedMax = Number.parseInt(body.maxOccurrences, 10);
      if (!Number.isFinite(parsedMax) || parsedMax < 1) {
        return res.status(400).json({ message: "Max occurrences must be a positive integer." });
      }
      existing.maxOccurrences = parsedMax;
    }
  }

  if (bodyHas(body, "active")) existing.active = Boolean(body.active);

  // Customer reference handling (mirrors create): explicit optionId wins.
  if (bodyHas(body, "customerOptionId")) {
    const ref = await resolveReferenceOption("customer", body.customerOptionId);
    if (ref.error) return res.status(400).json({ message: ref.error });
    if (ref.option) {
      existing.customerOptionId = ref.optionId;
      existing.customerName = ref.option.name;
      existing.customerPhone = ref.option.phone || "";
      existing.customerInstagram = normalizeInstagramHandle(ref.option.instagram);
      existing.customerEmail = ref.option.email || "";
      existing.customerAddress = ref.option.address || "";
      existing.customerReference = ref.option.reference || "";
    } else {
      existing.customerOptionId = null;
    }
  }
  if (bodyHas(body, "customerName")) existing.customerName = String(body.customerName || "").trim();
  if (bodyHas(body, "customerPhone")) existing.customerPhone = String(body.customerPhone || "").trim();
  if (bodyHas(body, "customerInstagram")) existing.customerInstagram = normalizeInstagramHandle(body.customerInstagram);
  if (bodyHas(body, "customerEmail")) existing.customerEmail = String(body.customerEmail || "").trim();
  if (bodyHas(body, "customerAddress")) existing.customerAddress = String(body.customerAddress || "").trim();
  if (bodyHas(body, "customerReference")) existing.customerReference = String(body.customerReference || "").trim();

  if (bodyHas(body, "productServiceOptionId")) {
    const ref = await resolveReferenceOption("product_service", body.productServiceOptionId);
    if (ref.error) return res.status(400).json({ message: ref.error });
    if (ref.option) {
      existing.productServiceOptionId = ref.optionId;
      existing.productServiceName = ref.option.name;
      existing.productServiceType = toProductServiceType(ref.option.optionType);
      existing.productServicePrice = Number(ref.option.price || 0);
    } else {
      existing.productServiceOptionId = null;
    }
  }
  if (bodyHas(body, "productServiceName")) existing.productServiceName = String(body.productServiceName || "").trim();
  if (bodyHas(body, "productServiceType")) existing.productServiceType = toProductServiceType(body.productServiceType);
  if (bodyHas(body, "productServicePrice")) {
    const parsed = parseMoneyInput(body.productServicePrice, "Product/service price");
    if (parsed.error) return res.status(400).json({ message: parsed.error });
    existing.productServicePrice = parsed.value;
  }

  // Recompute the next run when the schedule itself moved.
  if (scheduleChanged) {
    existing.nextRunDate = computeInitialNextRun(existing.startDate, existing.frequency, existing.interval);
  }

  await existing.save();
  return res.json(existing);
});

export const remove = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid recurring entry id." });
  }
  const deleted = await RecurringEntry.findByIdAndDelete(id);
  if (!deleted) {
    return res.status(404).json({ message: "Recurring entry not found." });
  }
  return res.json({ ok: true });
});

// Manually post any occurrences due right now for a single template.
export const runOne = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid recurring entry id." });
  }
  const recurring = await RecurringEntry.findById(id);
  if (!recurring) {
    return res.status(404).json({ message: "Recurring entry not found." });
  }
  const created = await postDueForRecurring(recurring);
  return res.json({ posted: created.length, recurring, entries: created });
});

// Cron-triggered: post everything due across all templates.
export const runDue = asyncHandler(async (_req, res) => {
  const summary = await postAllDue();
  return res.json({ ok: true, ...summary });
});
