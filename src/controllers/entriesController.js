import mongoose from "mongoose";
import { Entry } from "../models/Entry.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { InventoryTransaction } from "../models/InventoryTransaction.js";
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
  EXPENSE_CATEGORIES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE
} from "../constants.js";

function serializeUsageKey(itemId) {
  return String(itemId || "").trim();
}

function bodyHas(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

async function normalizeInventoryUsage(input) {
  if (!Array.isArray(input)) return { usage: [], inventoryCost: 0, error: null };

  const aggregated = new Map();
  for (const raw of input) {
    const itemId = serializeUsageKey(raw?.itemId);
    if (!mongoose.Types.ObjectId.isValid(itemId)) {
      return { usage: [], inventoryCost: 0, error: "Invalid inventory item id." };
    }
    const parsedQuantity = parseMoneyInput(raw?.quantity, "Inventory quantity");
    if (parsedQuantity.error || parsedQuantity.value <= 0) {
      return { usage: [], inventoryCost: 0, error: "Inventory quantity must be a positive number." };
    }
    aggregated.set(itemId, roundMoney((aggregated.get(itemId) || 0) + parsedQuantity.value));
  }

  if (aggregated.size === 0) return { usage: [], inventoryCost: 0, error: null };

  const items = await InventoryItem.find({ _id: { $in: Array.from(aggregated.keys()) } });
  const itemsById = new Map(items.map((item) => [String(item._id), item]));
  const usage = [];
  let inventoryCost = 0;

  for (const [itemId, quantity] of aggregated) {
    const item = itemsById.get(itemId);
    if (!item) return { usage: [], inventoryCost: 0, error: "Inventory item not found." };
    const costPerUnit = roundMoney(item.costPerUnit || 0);
    const totalCost = roundMoney(quantity * costPerUnit);
    inventoryCost = roundMoney(inventoryCost + totalCost);
    usage.push({
      itemId,
      name: item.name,
      sku: item.sku,
      quantity,
      costPerUnit,
      totalCost
    });
  }

  return { usage, inventoryCost, error: null };
}

function usageQuantityMap(usage = []) {
  const map = new Map();
  for (const item of usage || []) {
    const itemId = serializeUsageKey(item.itemId);
    if (!itemId) continue;
    map.set(itemId, roundMoney((map.get(itemId) || 0) + Number(item.quantity || 0)));
  }
  return map;
}

async function reconcileInventoryUsage(previousUsage, nextUsage, reason) {
  const previous = usageQuantityMap(previousUsage);
  const next = usageQuantityMap(nextUsage);
  const itemIds = Array.from(new Set([...previous.keys(), ...next.keys()]));

  for (const itemId of itemIds) {
    const delta = roundMoney((next.get(itemId) || 0) - (previous.get(itemId) || 0));
    if (delta === 0) continue;

    const item = await InventoryItem.findById(itemId);
    if (!item) throw Object.assign(new Error("Inventory item not found."), { status: 400 });
    const quantityBefore = item.quantity;
    const quantityAfter = roundMoney(quantityBefore - delta);
    if (quantityAfter < 0) {
      throw Object.assign(new Error(`Not enough stock for ${item.name}.`), { status: 400 });
    }

    item.quantity = quantityAfter;
    await item.save();
    await InventoryTransaction.create({
      itemId: item._id,
      type: delta > 0 ? "out" : "in",
      quantity: Math.abs(delta),
      reason,
      quantityBefore,
      quantityAfter
    });
  }
}

async function assertInventoryUsageAvailable(previousUsage, nextUsage) {
  const previous = usageQuantityMap(previousUsage);
  const next = usageQuantityMap(nextUsage);
  const itemIds = Array.from(new Set([...previous.keys(), ...next.keys()]));
  for (const itemId of itemIds) {
    const delta = roundMoney((next.get(itemId) || 0) - (previous.get(itemId) || 0));
    if (delta <= 0) continue;
    const item = await InventoryItem.findById(itemId).lean();
    if (!item) throw Object.assign(new Error("Inventory item not found."), { status: 400 });
    if (roundMoney((item.quantity || 0) - delta) < 0) {
      throw Object.assign(new Error(`Not enough stock for ${item.name}.`), { status: 400 });
    }
  }
}

export const list = asyncHandler(async (req, res) => {
  const { type, status, page, limit, search } = req.query;
  const query = {};

  if (type) {
    const typeFilter = String(type);
    if (!ENTRY_TYPES.includes(typeFilter)) {
      return res.status(400).json({ message: "Type filter must be Repair, Sales, Expenses, or Tip." });
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

  const searchText = String(search || "").trim();
  if (searchText) {
    const escapedSearch = searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const searchRegex = new RegExp(escapedSearch, "i");
    query.$or = [
      { description: searchRegex },
      { notes: searchRegex },
      { customerName: searchRegex },
      { customerPhone: searchRegex },
      { customerEmail: searchRegex },
      { customerReference: searchRegex },
      { productServiceName: searchRegex },
      { category: searchRegex }
    ];
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
    return res.status(400).json({ message: "Type must be Repair, Sales, Expenses, or Tip." });
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
  const rawCategory = String(body.category || "").trim();
  const category = type === "Expenses" && EXPENSE_CATEGORIES.includes(rawCategory) ? rawCategory : "";

  const parsedIncome = parseMoneyInput(body.income ?? 0, "Income");
  if (parsedIncome.error) {
    return res.status(400).json({ message: parsedIncome.error });
  }
  const parsedExpense = parseMoneyInput(body.expense ?? 0, "Expense");
  if (parsedExpense.error) {
    return res.status(400).json({ message: parsedExpense.error });
  }
  const income = parsedIncome.value;
  const manualExpense = parsedExpense.value;

  const inventory = await normalizeInventoryUsage(body.inventoryUsage);
  if (inventory.error) {
    return res.status(400).json({ message: inventory.error });
  }

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

  const rawTaxRate = body.taxRate !== undefined ? Number(body.taxRate) : undefined;
  const expense = roundMoney(manualExpense + inventory.inventoryCost);
  const amounts = computeAmounts(income, expense, type, rawTaxRate);
  await assertInventoryUsageAvailable([], inventory.usage);

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
    inventoryUsage: inventory.usage,
    inventoryCost: inventory.inventoryCost,
    ...amounts,
    notes,
    category,
    status
  });
  await reconcileInventoryUsage([], inventory.usage, `Used on record ${entry._id}`);

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
    return res.status(400).json({ message: "Type must be Repair, Sales, Expenses, or Tip." });
  }

  const date = req.body.date ? new Date(req.body.date) : existing.date;
  if (Number.isNaN(date.getTime())) {
    return res.status(400).json({ message: "Invalid date." });
  }

  let description = existing.description || "";
  if (bodyHas(req.body, "description")) {
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
    : { value: roundMoney((existing.expense || 0) - (existing.inventoryCost || 0)), error: null };
  if (parsedExpense.error) {
    return res.status(400).json({ message: parsedExpense.error });
  }

  const income = parsedIncome.value;
  const manualExpense = parsedExpense.value;
  const inventory = bodyHas(req.body, "inventoryUsage")
    ? await normalizeInventoryUsage(req.body.inventoryUsage)
    : {
        usage: existing.inventoryUsage || [],
        inventoryCost: Number(existing.inventoryCost || 0),
        error: null
      };
  if (inventory.error) {
    return res.status(400).json({ message: inventory.error });
  }

  const status = req.body.status !== undefined ? toStatus(req.body.status) : existing.status;
  if (!status) {
    return res.status(400).json({ message: "Status must be Pending, Completed, or Paid." });
  }
  const notes = req.body.notes !== undefined ? String(req.body.notes).trim() : existing.notes;
  const rawCategory = req.body.category !== undefined ? String(req.body.category || "").trim() : (existing.category || "");
  const category = type === "Expenses" && EXPENSE_CATEGORIES.includes(rawCategory) ? rawCategory : "";

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

  if (bodyHas(req.body, "customerName")) {
    customerName = String(req.body.customerName || "").trim();
    if (!bodyHas(req.body, "customerOptionId")) {
      customerOptionId = null;
    }
  }

  if (bodyHas(req.body, "customerPhone")) {
    customerPhone = String(req.body.customerPhone || "").trim();
  }

  if (bodyHas(req.body, "customerEmail")) {
    customerEmail = String(req.body.customerEmail || "").trim();
  }

  if (bodyHas(req.body, "customerAddress")) {
    customerAddress = String(req.body.customerAddress || "").trim();
  }

  if (bodyHas(req.body, "customerReference")) {
    customerReferenceLabel = String(req.body.customerReference || "").trim();
  }

  if (bodyHas(req.body, "productServiceName")) {
    productServiceName = String(req.body.productServiceName || "").trim();
    if (!bodyHas(req.body, "productServiceOptionId")) {
      productServiceOptionId = null;
    }
  }

  if (bodyHas(req.body, "productServiceType")) {
    productServiceType = toProductServiceType(req.body.productServiceType);
  }

  if (bodyHas(req.body, "productServicePrice")) {
    const parsedPrice = parseMoneyInput(req.body.productServicePrice, "Product/service price");
    if (parsedPrice.error) {
      return res.status(400).json({ message: parsedPrice.error });
    }
    productServicePrice = parsedPrice.value;
  }

  if (bodyHas(req.body, "customerOptionId")) {
    const customerRefOption = await resolveReferenceOption("customer", req.body.customerOptionId);
    if (customerRefOption.error) {
      return res.status(400).json({ message: customerRefOption.error });
    }

    if (!customerRefOption.option) {
      customerOptionId = null;
      if (!bodyHas(req.body, "customerName")) {
        customerName = "";
      }
      if (!bodyHas(req.body, "customerPhone")) {
        customerPhone = "";
      }
      if (!bodyHas(req.body, "customerEmail")) {
        customerEmail = "";
      }
      if (!bodyHas(req.body, "customerAddress")) {
        customerAddress = "";
      }
      if (!bodyHas(req.body, "customerReference")) {
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

  if (bodyHas(req.body, "productServiceOptionId")) {
    const productServiceReference = await resolveReferenceOption("product_service", req.body.productServiceOptionId);
    if (productServiceReference.error) {
      return res.status(400).json({ message: productServiceReference.error });
    }

    if (!productServiceReference.option) {
      productServiceOptionId = null;
      if (!bodyHas(req.body, "productServiceName")) {
        productServiceName = "";
      }
      if (!bodyHas(req.body, "productServiceType")) {
        productServiceType = "";
      }
      if (!bodyHas(req.body, "productServicePrice")) {
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

  const rawTaxRate = req.body.taxRate !== undefined ? Number(req.body.taxRate) : undefined;
  const expense = roundMoney(manualExpense + inventory.inventoryCost);
  const amounts = computeAmounts(income, expense, type, rawTaxRate);
  const previousUsage = existing.inventoryUsage ? existing.inventoryUsage.map((item) => item.toObject ? item.toObject() : item) : [];
  await assertInventoryUsageAvailable(previousUsage, inventory.usage);

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
  existing.inventoryUsage = inventory.usage;
  existing.inventoryCost = inventory.inventoryCost;
  existing.status = status || "Pending";
  existing.notes = notes;
  existing.category = category;

  await existing.save();
  await reconcileInventoryUsage(previousUsage, inventory.usage, `Updated record ${existing._id}`);
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
  await reconcileInventoryUsage(deleted.inventoryUsage || [], [], `Deleted record ${deleted._id}`);

  return res.json({ ok: true });
});

export const addPayment = asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }

  const entry = await Entry.findById(entryId);
  if (!entry) {
    return res.status(404).json({ message: "Entry not found." });
  }

  const parsedAmount = parseMoneyInput(req.body?.amount, "Amount");
  if (parsedAmount.error) {
    return res.status(400).json({ message: parsedAmount.error });
  }

  const date = new Date(req.body?.date);
  if (Number.isNaN(date.getTime())) {
    return res.status(400).json({ message: "Invalid payment date." });
  }

  const method = String(req.body?.method || "").trim();
  const note = String(req.body?.note || "").trim();

  entry.payments.push({ amount: parsedAmount.value, date, method, note, createdAt: new Date() });
  await entry.save();
  return res.json(entry);
});

export const deletePayment = asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  const paymentId = String(req.params?.paymentId || "").trim();

  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }
  if (!mongoose.Types.ObjectId.isValid(paymentId)) {
    return res.status(400).json({ message: "Invalid payment id." });
  }

  const entry = await Entry.findById(entryId);
  if (!entry) {
    return res.status(404).json({ message: "Entry not found." });
  }

  const paymentIndex = entry.payments.findIndex((p) => String(p._id) === paymentId);
  if (paymentIndex === -1) {
    return res.status(404).json({ message: "Payment not found." });
  }

  entry.payments.splice(paymentIndex, 1);
  await entry.save();
  return res.json(entry);
});
