import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";
import { InventoryTransaction } from "../models/InventoryTransaction.js";
import { asyncHandler, roundMoney, withTransaction } from "../utils.js";

export const listItems = asyncHandler(async (req, res) => {
  const { category, lowStock, search } = req.query;
  const query = { accountId: req.accountId };

  // Lets a part be found by a few typed words instead of scanning the full list.
  const searchText = String(search || "").trim();
  if (searchText) {
    const searchRegex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [{ name: searchRegex }, { sku: searchRegex }, { supplier: searchRegex }, { category: searchRegex }];
  }

  if (category) {
    query.category = String(category).trim();
  }

  if (lowStock === "true") {
    query.$expr = { $lte: ["$quantity", "$lowStockThreshold"] };
  }

  const items = await InventoryItem.find(query).sort({ name: 1 }).lean();
  return res.json(items);
});

const USAGE_WINDOW_DAYS = 60;
const STOCK_TARGET_DAYS = 30;
const RUNNING_OUT_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

// GET /api/inventory/reorder
//
// What to buy, and how many. A part is on the list when it is at or under its
// low-stock mark, or when the rate it has been used at over the last 60 days
// would empty it within two weeks. The suggested quantity brings it back to a
// month of stock at that rate, and never to less than twice its low-stock mark.
export const reorderList = asyncHandler(async (req, res) => {
  const now = new Date();
  const since = new Date(now.getTime() - USAGE_WINDOW_DAYS * DAY_MS);
  const [items, usage] = await Promise.all([
    InventoryItem.find({ accountId: req.accountId }).sort({ name: 1 }).lean(),
    InventoryTransaction.aggregate([
      { $match: { accountId: new mongoose.Types.ObjectId(String(req.accountId)), type: "out", createdAt: { $gte: since } } },
      { $group: { _id: "$itemId", used: { $sum: "$quantity" } } }
    ])
  ]);
  const usedById = new Map(usage.map((row) => [String(row._id), row.used]));

  const list = [];
  for (const item of items) {
    const used = roundMoney(usedById.get(String(item._id)) || 0);
    const perDay = used / USAGE_WINDOW_DAYS;
    const daysLeft = perDay > 0 ? Math.floor(item.quantity / perDay) : null;
    const low = item.quantity <= item.lowStockThreshold;
    const runningOut = daysLeft !== null && daysLeft <= RUNNING_OUT_DAYS;
    if (!low && !runningOut) continue;

    const target = Math.max(Math.ceil(perDay * STOCK_TARGET_DAYS), item.lowStockThreshold * 2, 1);
    const suggested = Math.max(1, Math.ceil(target - item.quantity));
    list.push({
      _id: String(item._id),
      name: item.name,
      sku: item.sku,
      supplier: item.supplier || "",
      quantity: item.quantity,
      lowStockThreshold: item.lowStockThreshold,
      usedLast60Days: used,
      daysLeft,
      reason: item.quantity <= 0 ? "out" : low ? "low" : "running_out",
      suggestedQuantity: suggested,
      costPerUnit: roundMoney(item.costPerUnit || 0),
      estimatedCost: roundMoney(suggested * (item.costPerUnit || 0))
    });
  }
  // What runs out first comes first; parts with no recent use go last.
  list.sort((a, b) => (a.daysLeft ?? Infinity) - (b.daysLeft ?? Infinity) || a.name.localeCompare(b.name));

  return res.json({
    generatedAt: now.toISOString(),
    windowDays: USAGE_WINDOW_DAYS,
    items: list,
    estimatedTotal: roundMoney(list.reduce((sum, item) => sum + item.estimatedCost, 0))
  });
});

export const getItem = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid item id." });
  }

  const item = await InventoryItem.findOne({ _id: id, accountId: req.accountId }).lean();
  if (!item) {
    return res.status(404).json({ message: "Item not found." });
  }

  return res.json(item);
});

export const createItem = asyncHandler(async (req, res) => {
  const body = req.body ?? {};

  const name = String(body.name || "").trim();
  if (!name) {
    return res.status(400).json({ message: "Name is required." });
  }

  const sku = String(body.sku || "").trim();
  if (!sku) {
    return res.status(400).json({ message: "SKU is required." });
  }

  const existing = await InventoryItem.findOne({ sku, accountId: req.accountId });
  if (existing) {
    return res.status(409).json({ message: "An item with this SKU already exists." });
  }

  const category = String(body.category || "").trim();
  const supplier = String(body.supplier || "").trim();

  const quantity = Number(body.quantity ?? 0);
  if (!Number.isFinite(quantity) || quantity < 0) {
    return res.status(400).json({ message: "Quantity must be a non-negative number." });
  }

  const costPerUnit = Number(body.costPerUnit ?? 0);
  if (!Number.isFinite(costPerUnit) || costPerUnit < 0) {
    return res.status(400).json({ message: "Cost per unit must be a non-negative number." });
  }

  const lowStockThreshold = Number(body.lowStockThreshold ?? 5);
  if (!Number.isFinite(lowStockThreshold) || lowStockThreshold < 0) {
    return res.status(400).json({ message: "Low stock threshold must be a non-negative number." });
  }

  const lastRestockedAt = body.lastRestockedAt ? new Date(body.lastRestockedAt) : null;
  if (lastRestockedAt && Number.isNaN(lastRestockedAt.getTime())) {
    return res.status(400).json({ message: "Invalid last restocked date." });
  }

  let item;
  try {
    item = await InventoryItem.create({
      accountId: req.accountId,
      name,
      sku,
      category,
      supplier,
      quantity: roundMoney(quantity),
      costPerUnit: roundMoney(costPerUnit),
      lowStockThreshold: Math.round(lowStockThreshold),
      lastRestockedAt
    });
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "An item with this SKU already exists." });
    }
    throw error;
  }

  if (quantity > 0) {
    await InventoryTransaction.create({
      accountId: req.accountId,
      itemId: item._id,
      type: "in",
      quantity: roundMoney(quantity),
      reason: "Initial stock",
      quantityBefore: 0,
      quantityAfter: roundMoney(quantity)
    });
  }

  return res.status(201).json(item);
});

export const updateItem = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid item id." });
  }

  const body = req.body ?? {};

  const item = await InventoryItem.findOne({ _id: id, accountId: req.accountId });
  if (!item) return res.status(404).json({ message: "Item not found." });

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ message: "Name is required." });
    item.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(body, "sku")) {
    const sku = String(body.sku || "").trim();
    if (!sku) return res.status(400).json({ message: "SKU is required." });
    const conflict = await InventoryItem.findOne({ sku, _id: { $ne: id }, accountId: req.accountId });
    if (conflict) return res.status(409).json({ message: "An item with this SKU already exists." });
    item.sku = sku;
  }

  if (Object.prototype.hasOwnProperty.call(body, "category")) {
    item.category = String(body.category || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(body, "supplier")) {
    item.supplier = String(body.supplier || "").trim();
  }

  if (Object.prototype.hasOwnProperty.call(body, "costPerUnit")) {
    const costPerUnit = Number(body.costPerUnit ?? 0);
    if (!Number.isFinite(costPerUnit) || costPerUnit < 0) {
      return res.status(400).json({ message: "Cost per unit must be a non-negative number." });
    }
    item.costPerUnit = roundMoney(costPerUnit);
  }

  if (Object.prototype.hasOwnProperty.call(body, "lowStockThreshold")) {
    const threshold = Number(body.lowStockThreshold ?? 0);
    if (!Number.isFinite(threshold) || threshold < 0) {
      return res.status(400).json({ message: "Low stock threshold must be a non-negative number." });
    }
    item.lowStockThreshold = Math.round(threshold);
  }

  if (Object.prototype.hasOwnProperty.call(body, "lastRestockedAt")) {
    const d = body.lastRestockedAt ? new Date(body.lastRestockedAt) : null;
    if (d && Number.isNaN(d.getTime())) {
      return res.status(400).json({ message: "Invalid last restocked date." });
    }
    item.lastRestockedAt = d;
  }

  try {
    await item.save();
  } catch (error) {
    if (error?.code === 11000) {
      return res.status(409).json({ message: "An item with this SKU already exists." });
    }
    throw error;
  }
  return res.json(item);
});

export const deleteItem = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid item id." });
  }

  const deleted = await InventoryItem.findOneAndDelete({ _id: id, accountId: req.accountId });
  if (!deleted) {
    return res.status(404).json({ message: "Item not found." });
  }

  await InventoryTransaction.deleteMany({ itemId: id, accountId: req.accountId });

  return res.json({ ok: true });
});

export const adjustQuantity = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid item id." });
  }

  const body = req.body ?? {};
  const type = String(body.type || "").trim();
  if (!["in", "out", "adjustment"].includes(type)) {
    return res.status(400).json({ message: "Type must be in, out, or adjustment." });
  }

  const qty = Number(body.quantity);
  if (!Number.isFinite(qty) || qty <= 0) {
    return res.status(400).json({ message: "Quantity must be a positive number." });
  }

  const reason = String(body.reason || "").trim();
  let item;
  let transaction;
  await withTransaction(async (session) => {
    const filter = { _id: id, accountId: req.accountId };
    const update = type === "adjustment"
      ? { $set: { quantity: roundMoney(qty) } }
      : { $inc: { quantity: type === "in" ? roundMoney(qty) : -roundMoney(qty) } };
    if (type === "out") filter.quantity = { $gte: qty };
    if (type === "in") update.$set = { lastRestockedAt: new Date() };

    const previous = await InventoryItem.findOneAndUpdate(filter, update, { new: false, session });
    if (!previous) {
      const exists = await InventoryItem.exists({ _id: id, accountId: req.accountId }).session(session);
      throw Object.assign(
        new Error(exists ? "Quantity cannot go below zero." : "Item not found."),
        { status: exists ? 400 : 404 }
      );
    }

    const quantityBefore = previous.quantity;
    const quantityAfter = type === "adjustment"
      ? roundMoney(qty)
      : roundMoney(quantityBefore + (type === "in" ? qty : -qty));
    item = await InventoryItem.findOne({ _id: id, accountId: req.accountId }).session(session);
    [transaction] = await InventoryTransaction.create([{
      accountId: req.accountId,
      itemId: previous._id,
      type,
      quantity: roundMoney(qty),
      reason,
      quantityBefore,
      quantityAfter
    }], { session });
  });

  return res.json({ item, transaction });
});

export const listTransactions = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid item id." });
  }

  const exists = await InventoryItem.exists({ _id: id, accountId: req.accountId });
  if (!exists) {
    return res.status(404).json({ message: "Item not found." });
  }

  const transactions = await InventoryTransaction.find({ itemId: id, accountId: req.accountId })
    .sort({ createdAt: -1 })
    .lean();

  return res.json(transactions);
});
