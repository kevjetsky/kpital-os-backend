import mongoose from "mongoose";
import { Entry } from "../models/Entry.js";
import {
  asyncHandler,
  parseMoneyInput,
  parsePaginationValue,
  computeAmounts,
  roundMoney,
  toStatus,
  toProductServiceType,
  resolveReferenceOption
} from "../utils.js";
import {
  ENTRY_TYPES,
  ENTRY_STATUSES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE
} from "../constants.js";

export const list = asyncHandler(async (req, res) => {
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
});

export const create = asyncHandler(async (req, res) => {
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
});

export const update = asyncHandler(async (req, res) => {
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
});

export const remove = asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }

  const deleted = await Entry.findByIdAndDelete(entryId);
  if (!deleted) {
    return res.status(404).json({ message: "Entry not found." });
  }

  return res.json({ ok: true });
});
