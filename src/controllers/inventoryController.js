import mongoose from "mongoose";
import { InventoryItem } from "../models/InventoryItem.js";
import { InventoryTransaction } from "../models/InventoryTransaction.js";
import { asyncHandler, roundMoney } from "../utils.js";

export const listItems = asyncHandler(async (req, res) => {
  const { category, lowStock } = req.query;
  const query = {};

  if (category) {
    query.category = String(category).trim();
  }

  if (lowStock === "true") {
    query.$expr = { $lte: ["$quantity", "$lowStockThreshold"] };
  }

  const items = await InventoryItem.find(query).sort({ name: 1 }).lean();
  return res.json(items);
});

export const getItem = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid item id." });
  }

  const item = await InventoryItem.findById(id).lean();
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

  const existing = await InventoryItem.findOne({ sku });
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

  const item = await InventoryItem.findById(id);
  if (!item) {
    return res.status(404).json({ message: "Item not found." });
  }

  const body = req.body ?? {};

  if (Object.prototype.hasOwnProperty.call(body, "name")) {
    const name = String(body.name || "").trim();
    if (!name) return res.status(400).json({ message: "Name is required." });
    item.name = name;
  }

  if (Object.prototype.hasOwnProperty.call(body, "sku")) {
    const sku = String(body.sku || "").trim();
    if (!sku) return res.status(400).json({ message: "SKU is required." });
    const conflict = await InventoryItem.findOne({ sku, _id: { $ne: id } });
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

  const deleted = await InventoryItem.findByIdAndDelete(id);
  if (!deleted) {
    return res.status(404).json({ message: "Item not found." });
  }

  await InventoryTransaction.deleteMany({ itemId: id });

  return res.json({ ok: true });
});

export const adjustQuantity = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid item id." });
  }

  const item = await InventoryItem.findById(id);
  if (!item) {
    return res.status(404).json({ message: "Item not found." });
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
  const quantityBefore = item.quantity;
  let quantityAfter;

  if (type === "in") {
    quantityAfter = roundMoney(quantityBefore + qty);
    item.lastRestockedAt = new Date();
  } else if (type === "out") {
    quantityAfter = roundMoney(quantityBefore - qty);
    if (quantityAfter < 0) {
      return res.status(400).json({ message: "Quantity cannot go below zero." });
    }
  } else {
    quantityAfter = roundMoney(qty);
  }

  item.quantity = quantityAfter;
  await item.save();

  const transaction = await InventoryTransaction.create({
    itemId: item._id,
    type,
    quantity: roundMoney(qty),
    reason,
    quantityBefore,
    quantityAfter
  });

  return res.json({ item, transaction });
});

export const listTransactions = asyncHandler(async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid item id." });
  }

  const exists = await InventoryItem.exists({ _id: id });
  if (!exists) {
    return res.status(404).json({ message: "Item not found." });
  }

  const transactions = await InventoryTransaction.find({ itemId: id })
    .sort({ createdAt: -1 })
    .lean();

  return res.json(transactions);
});
