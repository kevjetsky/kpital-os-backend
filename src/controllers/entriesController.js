import mongoose from "mongoose";
import { Entry } from "../models/Entry.js";
import { InventoryItem } from "../models/InventoryItem.js";
import { InventoryTransaction } from "../models/InventoryTransaction.js";
import { ReferenceOption } from "../models/ReferenceOption.js";
import { Settings } from "../models/Settings.js";
import {
  isCompletionStatus,
  sendWarrantySms,
  warrantyWindow
} from "../services/warrantySmsService.js";
import {
  asyncHandler,
  parseMoneyInput,
  parsePaginationValue,
  computeAmounts,
  roundMoney,
  toStatus,
  toProductServiceType,
  toPaymentMethod,
  resolveReferenceOption,
  normalizeInstagramHandle,
  normalizePhoneKey,
  generateWarrantyNumber,
  normalizeOptionName,
  deriveCustomerName,
  findCustomerByContact,
  toAccountObjectId,
  withTransaction
} from "../utils.js";
import {
  ENTRY_TYPES,
  ENTRY_STATUSES,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  CUSTOMER_REQUIRED_ENTRY_TYPES,
  PROFIT_NEUTRAL_ENTRY_TYPES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  WARRANTY_DAYS
} from "../constants.js";

function serializeUsageKey(itemId) {
  return String(itemId || "").trim();
}

// Every phone number or Instagram handle that lands on a record becomes a
// customer: link to an existing match, otherwise create one automatically.
// Returns the (lean) customer document the record should link to.
async function linkOrCreateCustomer(accountId, { name, phone, instagram, email, address, reference }) {
  const match = await findCustomerByContact(accountId, phone, instagram);
  if (match) {
    // Fill in contact info the customer was missing, but never overwrite.
    const fills = {};
    if (phone && !match.phone) fills.phone = phone;
    if (instagram && !match.instagram) fills.instagram = instagram;
    if (phone) fills.phoneKey = normalizePhoneKey(phone);
    if (instagram) fills.instagramKey = normalizeInstagramHandle(instagram);
    if (email && !match.email) fills.email = email;
    if (Object.keys(fills).length > 0) {
      await ReferenceOption.updateOne({ _id: match._id, accountId }, { $set: fills });
    }
    return { ...match, ...fills };
  }

  const baseName = deriveCustomerName(name, phone, instagram);
  const payload = {
    accountId,
    kind: "customer",
    name: baseName,
    normalizedName: normalizeOptionName(baseName),
    phone: phone || "",
    phoneKey: normalizePhoneKey(phone),
    instagram: instagram || "",
    instagramKey: normalizeInstagramHandle(instagram),
    email: email || "",
    address: address || "",
    reference: reference || ""
  };

  try {
    const created = await ReferenceOption.create(payload);
    return created.toObject();
  } catch (error) {
    if (error?.code === 11000) {
      // The typed name collides with a different customer; disambiguate it
      // with the contact info so the record can still be saved.
      const fallbackName = `${baseName} (${phone || `@${instagram}`})`;
      const created = await ReferenceOption.create({
        ...payload,
        name: fallbackName,
        normalizedName: normalizeOptionName(fallbackName)
      });
      return created.toObject();
    }
    throw error;
  }
}

function bodyHas(body, key) {
  return Object.prototype.hasOwnProperty.call(body || {}, key);
}

// Assigns the warranty code and window the first time a job reaches a finished
// status. Deliberately independent of whether SMS is switched on: the code is
// what the customer quotes when they call, so it has to exist even for accounts
// that never text anyone.
//
// The code is only minted on completion, not at booking, so records that are
// created and cancelled don't burn codes, and the warranty clock starts when
// the work actually finished.
async function assignWarrantyOnCompletion(accountId, entry, smsSettings) {
  if (entry.warrantyNumber) return entry;
  const types = smsSettings?.entryTypes?.length ? smsSettings.entryTypes : ["Repair"];
  if (!types.includes(entry.type)) return entry;

  const completedAt = new Date();
  const { start, end } = warrantyWindow(completedAt, WARRANTY_DAYS);
  entry.warrantyStartsAt = start;
  entry.warrantyEndsAt = end;

  // Codes are random, so a collision is possible if rare. Retry a few times
  // rather than failing the customer's record save over it.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = generateWarrantyNumber();
    const taken = await Entry.findOne({ accountId, warrantyNumber: candidate }).select("_id").lean();
    if (!taken) {
      entry.warrantyNumber = candidate;
      return entry;
    }
  }
  // Out of attempts: leave the code empty rather than block the save. The
  // record still completes; the text is skipped and visible as such.
  return entry;
}

// Fires the warranty text after a record is saved. Never throws and never
// blocks the response on a carrier error — the record save is the user's
// action, and a texting failure must not undo it.
async function dispatchWarrantySms(accountId, entry) {
  try {
    const account = await Settings.findById(accountId).select("sms").lean();
    if (!account?.sms?.enabled) return;
    await sendWarrantySms(accountId, entry, account.sms);
  } catch (error) {
    console.error("Warranty SMS dispatch failed:", error);
  }
}

// Validates the warranty-callback fields on create/update. Returns
// { isWarrantyCallback, callbackOf, callbackReason, error }.
async function resolveCallbackFields(accountId, body, { selfId = null, existing = null } = {}) {
  let isWarrantyCallback = existing ? !!existing.isWarrantyCallback : false;
  let callbackOf = existing?.callbackOf ? String(existing.callbackOf) : null;
  let callbackReason = existing?.callbackReason || "";

  if (bodyHas(body, "callbackReason")) {
    callbackReason = String(body.callbackReason || "").trim();
  }
  if (bodyHas(body, "isWarrantyCallback")) {
    isWarrantyCallback = Boolean(body.isWarrantyCallback);
  }
  if (bodyHas(body, "callbackOf")) {
    const raw = body.callbackOf === null ? "" : String(body.callbackOf || "").trim();
    if (!raw) {
      callbackOf = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(raw)) {
        return { error: "Invalid callbackOf entry id." };
      }
      if (selfId && raw === String(selfId)) {
        return { error: "An entry cannot be a callback of itself." };
      }
      const original = await Entry.findOne({ _id: raw, accountId }).lean();
      if (!original) {
        return { error: "Original entry for callbackOf not found." };
      }
      callbackOf = raw;
      // Linking to an original job implies this record is a callback.
      isWarrantyCallback = true;
    }
  }

  if (!isWarrantyCallback) {
    callbackOf = null;
    callbackReason = "";
  }

  return { isWarrantyCallback, callbackOf, callbackReason, error: null };
}

// A Refund points at the record it hands money back for. The link is optional —
// money refunded for work that predates the app has nothing to point at — but
// when present it must be a real record of this account that actually took money
// in, since you cannot refund an expense.
async function resolveRefundOf(accountId, body, { type, selfId = null, existing = null } = {}) {
  let refundOf = existing?.refundOf ? String(existing.refundOf) : null;

  if (bodyHas(body, "refundOf")) {
    const raw = body.refundOf === null ? "" : String(body.refundOf || "").trim();
    if (!raw) {
      refundOf = null;
    } else {
      if (!mongoose.Types.ObjectId.isValid(raw)) {
        return { error: "Invalid refundOf entry id." };
      }
      if (selfId && raw === String(selfId)) {
        return { error: "A refund cannot refund itself." };
      }
      const original = await Entry.findOne({ _id: raw, accountId }).lean();
      if (!original) {
        return { error: "Original entry for refundOf not found." };
      }
      if (!(original.income > 0)) {
        return { error: "Only a record that took money in can be refunded." };
      }
      refundOf = raw;
    }
  }

  // Retyping a refund into something else drops the link rather than leaving a
  // Sales record claiming to reverse another entry.
  if (type !== "Refund") {
    refundOf = null;
  }

  return { refundOf, error: null };
}

// The rate to reverse on a refund. A linked original gives back exactly the tax
// it charged — prorated when only part of the sale is refunded — which stays
// correct even if the account's tax rate changed since. Unlinked refunds fall
// back to the current rate.
async function resolveRefundTaxRate(accountId, refundOf, fallbackRate) {
  if (!refundOf) return fallbackRate;
  const original = await Entry.findOne({ _id: refundOf, accountId }).select("income salesTax").lean();
  if (!original || !(original.income > 0)) return fallbackRate;
  return Math.min(1, Math.max(0, (original.salesTax || 0) / original.income));
}

async function normalizeInventoryUsage(accountId, input) {
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

  const items = await InventoryItem.find({ accountId, _id: { $in: Array.from(aggregated.keys()) } });
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

async function reconcileInventoryUsage(accountId, previousUsage, nextUsage, reason, session) {
  const previous = usageQuantityMap(previousUsage);
  const next = usageQuantityMap(nextUsage);
  const itemIds = Array.from(new Set([...previous.keys(), ...next.keys()]));

  for (const itemId of itemIds) {
    const delta = roundMoney((next.get(itemId) || 0) - (previous.get(itemId) || 0));
    if (delta === 0) continue;

    const quantityChange = -delta;
    const filter = { _id: itemId, accountId };
    if (delta > 0) filter.quantity = { $gte: delta };
    const item = await InventoryItem.findOneAndUpdate(
      filter,
      { $inc: { quantity: quantityChange } },
      { new: false, session }
    );
    if (!item) throw Object.assign(new Error("Inventory item not found."), { status: 400 });
    const quantityBefore = item.quantity;
    const quantityAfter = roundMoney(quantityBefore + quantityChange);
    await InventoryTransaction.create([{
      accountId,
      itemId: item._id,
      type: delta > 0 ? "out" : "in",
      quantity: Math.abs(delta),
      reason,
      quantityBefore,
      quantityAfter
    }], { session });
  }
}

async function assertInventoryUsageAvailable(accountId, previousUsage, nextUsage) {
  const previous = usageQuantityMap(previousUsage);
  const next = usageQuantityMap(nextUsage);
  const itemIds = Array.from(new Set([...previous.keys(), ...next.keys()]));
  for (const itemId of itemIds) {
    const delta = roundMoney((next.get(itemId) || 0) - (previous.get(itemId) || 0));
    if (delta <= 0) continue;
    const item = await InventoryItem.findOne({ _id: itemId, accountId }).lean();
    if (!item) throw Object.assign(new Error("Inventory item not found."), { status: 400 });
    if (roundMoney((item.quantity || 0) - delta) < 0) {
      throw Object.assign(new Error(`Not enough stock for ${item.name}.`), { status: 400 });
    }
  }
}

// Hydrates both ends of the refund link on a page of lean entries, so the table
// can badge a refunded sale and a refund can name what it reversed without the
// client hunting for records that may not even be on the same page.
//
// Two indexed queries per page rather than a stored counter on the original:
// refunds are rare, and a denormalized total would have to be maintained on
// every refund create, retype, relink and delete to avoid drifting.
async function attachRefundLinks(accountId, entries) {
  if (!Array.isArray(entries) || entries.length === 0) return entries;

  const SUMMARY_FIELDS = "date description productServiceName type income expense customerName";
  const pageIds = entries.map((entry) => entry._id);
  const originalIds = Array.from(
    new Set(entries.map((entry) => entry.refundOf).filter(Boolean).map(String))
  );

  const [refunds, originals] = await Promise.all([
    Entry.find({ accountId, refundOf: { $in: pageIds } }).select(`${SUMMARY_FIELDS} refundOf`).lean(),
    originalIds.length
      ? Entry.find({ accountId, _id: { $in: originalIds } }).select(SUMMARY_FIELDS).lean()
      : []
  ]);

  const refundsByOriginal = new Map();
  for (const refund of refunds) {
    const key = String(refund.refundOf);
    if (!refundsByOriginal.has(key)) refundsByOriginal.set(key, []);
    refundsByOriginal.get(key).push(refund);
  }
  const originalsById = new Map(originals.map((original) => [String(original._id), original]));

  for (const entry of entries) {
    const linked = refundsByOriginal.get(String(entry._id)) || [];
    entry.refunds = linked;
    entry.refundedTotal = roundMoney(linked.reduce((sum, refund) => sum + (refund.expense || 0), 0));
    entry.refundOfEntry = entry.refundOf ? originalsById.get(String(entry.refundOf)) || null : null;
  }

  return entries;
}

export const list = asyncHandler(async (req, res) => {
  const { type, status, page, limit, search, callbacks } = req.query;
  const query = { accountId: req.accountId };

  if (callbacks !== undefined) {
    const flag = String(callbacks).toLowerCase();
    if (flag === "true" || flag === "1") {
      query.isWarrantyCallback = true;
    } else if (flag === "false" || flag === "0") {
      query.isWarrantyCallback = { $ne: true };
    }
  }

  if (type) {
    const typeFilter = String(type);
    if (!ENTRY_TYPES.includes(typeFilter)) {
      return res.status(400).json({ message: `Type filter must be one of: ${ENTRY_TYPES.join(", ")}.` });
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
      { customerInstagram: searchRegex },
      { customerEmail: searchRegex },
      { customerReference: searchRegex },
      { productServiceName: searchRegex },
      { category: searchRegex }
    ];
  }

  const hasPagination = page !== undefined || limit !== undefined;
  if (!hasPagination) {
    const entries = await Entry.find(query).sort({ date: -1, createdAt: -1 }).lean();
    return res.json(await attachRefundLinks(req.accountId, entries));
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
    items: await attachRefundLinks(req.accountId, entries),
    pagination: {
      page: parsedPage,
      limit: cappedLimit,
      total,
      totalPages
    }
  });
});

// GET /api/entries/summary?from&to[&year&quarter]
//
// The dashboard's headline numbers used to be derived in the browser from the
// full entry list, which meant downloading every record the account has ever
// had just to render four totals. This computes them in Mongo instead; the
// { accountId, date } index covers the range match.
//
// The quarter defaults to the server's current UTC quarter, but the client
// should pass its own year/quarter so "this quarter" means the same thing on a
// phone west of UTC as it does on the server.
export const summary = asyncHandler(async (req, res) => {
  const { from, to, year, quarter } = req.query;

  const now = new Date();
  const toDate = to ? new Date(String(to)) : now;
  const fromDate = from ? new Date(String(from)) : new Date(toDate.getFullYear(), 0, 1);
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return res.status(400).json({ message: "Invalid from/to date." });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ message: "'from' must be before 'to'." });
  }
  // `to` arrives as a calendar day (2026-06-30), which parses to that day's
  // midnight; without this the last day of the range would be excluded.
  const rangeEnd = new Date(toDate.getTime());
  if (rangeEnd.getUTCHours() === 0 && rangeEnd.getUTCMinutes() === 0 && rangeEnd.getUTCSeconds() === 0) {
    rangeEnd.setUTCHours(23, 59, 59, 999);
  }

  const quarterYear = year === undefined ? now.getUTCFullYear() : Number(year);
  const quarterNumber = quarter === undefined ? Math.floor(now.getUTCMonth() / 3) + 1 : Number(quarter);
  if (!Number.isInteger(quarterYear) || quarterYear < 1970 || quarterYear > 9999) {
    return res.status(400).json({ message: "Invalid year." });
  }
  if (!Number.isInteger(quarterNumber) || quarterNumber < 1 || quarterNumber > 4) {
    return res.status(400).json({ message: "Quarter must be between 1 and 4." });
  }
  const quarterStart = new Date(Date.UTC(quarterYear, (quarterNumber - 1) * 3, 1));
  const quarterEnd = new Date(Date.UTC(quarterYear, quarterNumber * 3, 1));

  const accountId = toAccountObjectId(req.accountId);

  const [rangeRows, statusRows, quarterRows] = await Promise.all([
    Entry.aggregate([
      { $match: { accountId, date: { $gte: fromDate, $lte: rangeEnd } } },
      {
        $group: {
          _id: null,
          income: { $sum: "$income" },
          // Owner draws are cash out but not a business expense, so they are
          // split into their own total instead of inflating this one. They
          // already carry netProfit: 0, so `net` needs no special handling.
          expense: {
            $sum: { $cond: [{ $in: ["$type", PROFIT_NEUTRAL_ENTRY_TYPES] }, 0, "$expense"] }
          },
          ownerDraws: {
            $sum: { $cond: [{ $in: ["$type", PROFIT_NEUTRAL_ENTRY_TYPES] }, "$expense", 0] }
          },
          salesTax: { $sum: "$salesTax" },
          net: { $sum: "$netProfit" },
          count: { $sum: 1 }
        }
      }
    ]),
    // Account-wide, deliberately not range-scoped: the action cards count every
    // open record, not just the ones in the selected period.
    Entry.aggregate([
      { $match: { accountId } },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]),
    Entry.aggregate([
      { $match: { accountId, date: { $gte: quarterStart, $lt: quarterEnd } } },
      { $group: { _id: null, salesTax: { $sum: "$salesTax" } } }
    ])
  ]);

  const totals = rangeRows[0] || {};
  const statusCounts = { Pending: 0, Completed: 0, Paid: 0 };
  let totalRecords = 0;
  for (const row of statusRows) {
    if (row._id in statusCounts) statusCounts[row._id] = row.count;
    totalRecords += row.count;
  }

  return res.json({
    range: {
      from: fromDate.toISOString(),
      to: rangeEnd.toISOString(),
      income: roundMoney(totals.income || 0),
      expense: roundMoney(totals.expense || 0),
      ownerDraws: roundMoney(totals.ownerDraws || 0),
      salesTax: roundMoney(totals.salesTax || 0),
      net: roundMoney(totals.net || 0),
      count: totals.count || 0
    },
    statusCounts,
    totalRecords,
    // Derived here so the client does not have to know that "unpaid" means
    // anything that is not Paid.
    pendingRecords: statusCounts.Pending,
    unpaidRecords: totalRecords - statusCounts.Paid,
    quarter: {
      year: quarterYear,
      quarter: quarterNumber,
      salesTax: roundMoney(quarterRows[0]?.salesTax || 0)
    }
  });
});

// GET /api/entries/warranty-candidates
// Given a customer (customerOptionId, or phone/instagram to match), returns
// their recent Repair entries inside the warranty window — the jobs a new
// visit could be a callback on.
export const warrantyCandidates = asyncHandler(async (req, res) => {
  const { customerOptionId, phone, instagram, date, windowDays, excludeId } = req.query;

  const parsedWindow = windowDays !== undefined ? Number(windowDays) : WARRANTY_DAYS;
  if (!Number.isFinite(parsedWindow) || parsedWindow <= 0 || parsedWindow > 365) {
    return res.status(400).json({ message: "windowDays must be a number between 1 and 365." });
  }

  const referenceDate = date ? new Date(String(date)) : new Date();
  if (Number.isNaN(referenceDate.getTime())) {
    return res.status(400).json({ message: "Invalid date." });
  }

  let optionId = String(customerOptionId || "").trim();
  if (optionId && !mongoose.Types.ObjectId.isValid(optionId)) {
    return res.status(400).json({ message: "Invalid customerOptionId." });
  }
  if (!optionId) {
    const cleanPhone = String(phone || "").trim();
    const cleanInstagram = normalizeInstagramHandle(instagram);
    if (!cleanPhone && !cleanInstagram) {
      return res.status(400).json({ message: "Provide customerOptionId, phone, or instagram." });
    }
    const match = await findCustomerByContact(req.accountId, cleanPhone, cleanInstagram);
    if (!match) {
      return res.json({ windowDays: parsedWindow, customerOptionId: null, candidates: [] });
    }
    optionId = String(match._id);
  }

  const windowStart = new Date(referenceDate.getTime() - parsedWindow * 24 * 60 * 60 * 1000);
  const query = {
    accountId: req.accountId,
    customerOptionId: optionId,
    type: "Repair",
    date: { $gte: windowStart, $lte: referenceDate }
  };
  const cleanExcludeId = String(excludeId || "").trim();
  if (cleanExcludeId && mongoose.Types.ObjectId.isValid(cleanExcludeId)) {
    query._id = { $ne: cleanExcludeId };
  }

  const candidates = await Entry.find(query)
    .sort({ date: -1 })
    .select("date description productServiceName income status isWarrantyCallback callbackOf customerName")
    .lean();

  return res.json({ windowDays: parsedWindow, customerOptionId: optionId, candidates });
});

// GET /api/entries/refund-candidates
// Records a refund can point at: anything that actually took money in. Scoped
// to one customer when contact details are known (refunding the person in front
// of you), otherwise the most recent money-in records, searchable by hand for
// the case where the refund is booked without customer details.
export const refundCandidates = asyncHandler(async (req, res) => {
  const { customerOptionId, phone, instagram, search, excludeId, limit } = req.query;

  const parsedLimit = limit !== undefined ? Number(limit) : 20;
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    return res.status(400).json({ message: "limit must be an integer between 1 and 100." });
  }

  const query = { accountId: req.accountId, income: { $gt: 0 } };

  let optionId = String(customerOptionId || "").trim();
  if (optionId && !mongoose.Types.ObjectId.isValid(optionId)) {
    return res.status(400).json({ message: "Invalid customerOptionId." });
  }
  if (!optionId) {
    const cleanPhone = String(phone || "").trim();
    const cleanInstagram = normalizeInstagramHandle(instagram);
    if (cleanPhone || cleanInstagram) {
      const match = await findCustomerByContact(req.accountId, cleanPhone, cleanInstagram);
      optionId = match ? String(match._id) : "";
    }
  }
  if (optionId) {
    query.customerOptionId = optionId;
  }

  const searchText = String(search || "").trim();
  if (searchText) {
    const searchRegex = new RegExp(searchText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    query.$or = [
      { description: searchRegex },
      { productServiceName: searchRegex },
      { customerName: searchRegex },
      { notes: searchRegex }
    ];
  }

  const cleanExcludeId = String(excludeId || "").trim();
  if (cleanExcludeId && mongoose.Types.ObjectId.isValid(cleanExcludeId)) {
    query._id = { $ne: cleanExcludeId };
  }

  const candidates = await Entry.find(query)
    .sort({ date: -1, createdAt: -1 })
    .limit(parsedLimit)
    .select("date type description productServiceName income salesTax status customerName")
    .lean();

  // How much of each has already been handed back, so a partial refund can be
  // topped up without refunding the same job twice over by accident.
  const refunds = await Entry.find({
    accountId: req.accountId,
    refundOf: { $in: candidates.map((candidate) => candidate._id) }
  }).select("refundOf expense").lean();

  const refundedByOriginal = new Map();
  for (const refund of refunds) {
    const key = String(refund.refundOf);
    refundedByOriginal.set(key, roundMoney((refundedByOriginal.get(key) || 0) + (refund.expense || 0)));
  }
  for (const candidate of candidates) {
    candidate.refundedTotal = refundedByOriginal.get(String(candidate._id)) || 0;
  }

  return res.json({ customerOptionId: optionId || null, candidates });
});

// GET /api/entries/callback-stats
// Meters warranty callbacks over a date range: rate, cost eaten, time to
// failure, and which repair types generate them.
export const callbackStats = asyncHandler(async (req, res) => {
  const { from, to } = req.query;

  const now = new Date();
  const toDate = to ? new Date(String(to)) : now;
  const fromDate = from
    ? new Date(String(from))
    : new Date(toDate.getFullYear(), toDate.getMonth() - 11, 1); // default: last 12 months
  if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
    return res.status(400).json({ message: "Invalid from/to date." });
  }
  if (fromDate > toDate) {
    return res.status(400).json({ message: "'from' must be before 'to'." });
  }

  const rangeQuery = { accountId: req.accountId, date: { $gte: fromDate, $lte: toDate } };
  const [callbacks, totalRepairs, repairsByTypeAgg] = await Promise.all([
    Entry.find({ ...rangeQuery, isWarrantyCallback: true }).lean(),
    Entry.countDocuments({ ...rangeQuery, type: "Repair", isWarrantyCallback: { $ne: true } }),
    Entry.aggregate([
      {
        $match: {
          ...rangeQuery,
          accountId: toAccountObjectId(req.accountId),
          type: "Repair",
          isWarrantyCallback: { $ne: true }
        }
      },
      { $group: { _id: { $ifNull: ["$productServiceName", ""] }, repairs: { $sum: 1 } } }
    ])
  ]);

  const originalIds = callbacks
    .map((cb) => cb.callbackOf)
    .filter((id) => id)
    .map((id) => String(id));
  const originals = originalIds.length
    ? await Entry.find({ accountId: req.accountId, _id: { $in: originalIds } })
        .select("date productServiceName productServiceOptionId inventoryUsage")
        .lean()
    : [];
  const originalsById = new Map(originals.map((entry) => [String(entry._id), entry]));

  let partsCost = 0;
  let totalExpense = 0;
  const daysToCallback = [];
  const byType = new Map();

  for (const cb of callbacks) {
    partsCost = roundMoney(partsCost + (cb.inventoryCost || 0));
    // Guard rather than assumption: a draw is never rework, but this figure is
    // "what callbacks cost the business", which a capital distribution is not.
    if (!PROFIT_NEUTRAL_ENTRY_TYPES.includes(cb.type)) {
      totalExpense = roundMoney(totalExpense + (cb.expense || 0));
    }

    const original = cb.callbackOf ? originalsById.get(String(cb.callbackOf)) : null;
    // Group by the original job's repair type when linked; otherwise fall back
    // to the callback's own service name.
    const typeName = (original?.productServiceName || cb.productServiceName || "(unspecified)").trim() || "(unspecified)";
    byType.set(typeName, (byType.get(typeName) || 0) + 1);

    if (original?.date && cb.date) {
      const days = Math.round((new Date(cb.date) - new Date(original.date)) / (24 * 60 * 60 * 1000));
      if (Number.isFinite(days) && days >= 0) daysToCallback.push(days);
    }
  }

  daysToCallback.sort((a, b) => a - b);
  const medianDays = daysToCallback.length
    ? daysToCallback[Math.floor((daysToCallback.length - 1) / 2)]
    : null;
  const avgDays = daysToCallback.length
    ? Math.round(daysToCallback.reduce((sum, d) => sum + d, 0) / daysToCallback.length)
    : null;

  const repairsByType = new Map(
    repairsByTypeAgg.map((row) => [(row._id || "(unspecified)").trim() || "(unspecified)", row.repairs])
  );
  const byRepairType = Array.from(byType.entries())
    .map(([name, count]) => {
      const repairs = repairsByType.get(name) || 0;
      return {
        name,
        callbacks: count,
        repairs,
        rate: repairs > 0 ? Number((count / repairs).toFixed(4)) : null
      };
    })
    .sort((a, b) => b.callbacks - a.callbacks);

  return res.json({
    from: fromDate,
    to: toDate,
    warrantyDays: WARRANTY_DAYS,
    totalRepairs,
    callbackCount: callbacks.length,
    callbackRate: totalRepairs > 0 ? Number((callbacks.length / totalRepairs).toFixed(4)) : null,
    callbackPartsCost: partsCost,
    callbackTotalExpense: totalExpense,
    medianDaysToCallback: medianDays,
    avgDaysToCallback: avgDays,
    byRepairType,
    recentCallbacks: callbacks
      .sort((a, b) => new Date(b.date) - new Date(a.date))
      .slice(0, 20)
      .map((cb) => ({
        _id: cb._id,
        date: cb.date,
        customerName: cb.customerName,
        description: cb.description,
        productServiceName: cb.productServiceName,
        callbackOf: cb.callbackOf,
        callbackReason: cb.callbackReason,
        inventoryCost: cb.inventoryCost,
        expense: cb.expense
      }))
  });
});

export const create = asyncHandler(async (req, res) => {
  const body = req.body ?? {};
  const type = String(body.type || "");

  if (!ENTRY_TYPES.includes(type)) {
    return res.status(400).json({ message: `Type must be one of: ${ENTRY_TYPES.join(", ")}.` });
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
  const suppressSms = Boolean(body.suppressSms);

  const callback = await resolveCallbackFields(req.accountId, body);
  if (callback.error) {
    return res.status(400).json({ message: callback.error });
  }

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

  const inventory = await normalizeInventoryUsage(req.accountId, body.inventoryUsage);
  if (inventory.error) {
    return res.status(400).json({ message: inventory.error });
  }

  let customerName = String(body.customerName || "").trim();
  let customerPhone = String(body.customerPhone || "").trim();
  let customerInstagram = normalizeInstagramHandle(body.customerInstagram);
  let customerEmail = String(body.customerEmail || "").trim();
  let customerAddress = String(body.customerAddress || "").trim();
  let customerReferenceLabel = String(body.customerReference || "").trim();
  let customerOptionId = null;

  const rawPaymentMethod = String(body.paymentMethod || "").trim();
  const paymentMethod = toPaymentMethod(rawPaymentMethod);
  if (rawPaymentMethod && !paymentMethod) {
    return res.status(400).json({ message: `Payment method must be one of: ${PAYMENT_METHODS.join(", ")}.` });
  }
  if (status === "Paid" && !paymentMethod) {
    return res.status(400).json({ message: "A payment method is required to mark a record as Paid." });
  }

  let productServiceName = String(body.productServiceName || "").trim();
  let productServiceType = toProductServiceType(body.productServiceType);
  const parsedProductPrice = parseMoneyInput(body.productServicePrice ?? 0, "Product/service price");
  if (parsedProductPrice.error) {
    return res.status(400).json({ message: parsedProductPrice.error });
  }
  let productServicePrice = parsedProductPrice.value;
  let productServiceOptionId = null;

  const customerRefOption = await resolveReferenceOption(req.accountId, "customer", body.customerOptionId);
  if (customerRefOption.error) {
    return res.status(400).json({ message: customerRefOption.error });
  }
  if (customerRefOption.option) {
    const option = customerRefOption.option;
    customerOptionId = customerRefOption.optionId;
    // Typed values win over the stored snapshot; the option fills the blanks.
    customerName = customerName || option.name;
    customerPhone = customerPhone || option.phone || "";
    customerInstagram = customerInstagram || normalizeInstagramHandle(option.instagram);
    customerEmail = customerEmail || option.email || "";
    customerAddress = customerAddress || option.address || "";
    customerReferenceLabel = customerReferenceLabel || option.reference || "";

    // Backfill contact info the selected customer was missing.
    const fills = {};
    if (customerPhone && !option.phone) fills.phone = customerPhone;
    if (customerInstagram && !option.instagram) fills.instagram = customerInstagram;
    if (customerPhone) fills.phoneKey = normalizePhoneKey(customerPhone);
    if (customerInstagram) fills.instagramKey = normalizeInstagramHandle(customerInstagram);
    if (Object.keys(fills).length > 0) {
      await ReferenceOption.updateOne({ _id: option._id, accountId: req.accountId }, { $set: fills });
    }
  } else if (customerPhone || customerInstagram) {
    const customer = await linkOrCreateCustomer(req.accountId, {
      name: customerName,
      phone: customerPhone,
      instagram: customerInstagram,
      email: customerEmail,
      address: customerAddress,
      reference: customerReferenceLabel
    });
    customerOptionId = String(customer._id);
    customerName = customerName || customer.name;
    customerPhone = customerPhone || customer.phone || "";
    customerInstagram = customerInstagram || normalizeInstagramHandle(customer.instagram);
    customerEmail = customerEmail || customer.email || "";
    customerAddress = customerAddress || customer.address || "";
    customerReferenceLabel = customerReferenceLabel || customer.reference || "";
  }

  if (CUSTOMER_REQUIRED_ENTRY_TYPES.includes(type) && !customerPhone && !customerInstagram) {
    return res.status(400).json({
      message: `A customer phone number or Instagram username is required for ${type} records.`
    });
  }

  const productServiceReference = await resolveReferenceOption(req.accountId, "product_service", body.productServiceOptionId);
  if (productServiceReference.error) {
    return res.status(400).json({ message: productServiceReference.error });
  }
  if (productServiceReference.option) {
    productServiceName = productServiceReference.option.name;
    productServiceType = toProductServiceType(productServiceReference.option.optionType);
    productServicePrice = roundMoney(productServiceReference.option.price || 0);
    productServiceOptionId = productServiceReference.optionId;
  }

  if (!customerName && !customerPhone && !customerInstagram) {
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

  const refund = await resolveRefundOf(req.accountId, body, { type });
  if (refund.error) {
    return res.status(400).json({ message: refund.error });
  }

  const rawTaxRate = body.taxRate !== undefined ? Number(body.taxRate) : undefined;
  const taxRate = await resolveRefundTaxRate(req.accountId, refund.refundOf, rawTaxRate);
  const expense = roundMoney(manualExpense + inventory.inventoryCost);
  const amounts = computeAmounts(income, expense, type, taxRate);
  await assertInventoryUsageAvailable(req.accountId, [], inventory.usage);

  let entry;
  // A record can be booked straight to Completed/Paid (walk-in paid on the
  // spot), so the warranty has to be assigned here too, not only on update.
  const account = await Settings.findById(req.accountId).select("sms").lean();
  const warranty = { warrantyNumber: "", warrantyStartsAt: null, warrantyEndsAt: null };
  if (isCompletionStatus(status)) {
    const draft = { type, warrantyNumber: "" };
    await assignWarrantyOnCompletion(req.accountId, draft, account?.sms);
    warranty.warrantyNumber = draft.warrantyNumber;
    warranty.warrantyStartsAt = draft.warrantyStartsAt || null;
    warranty.warrantyEndsAt = draft.warrantyEndsAt || null;
  }

  await withTransaction(async (session) => {
    [entry] = await Entry.create([{
    accountId: req.accountId,
    date,
    type,
    description,
    ...warranty,
    suppressSms,
    customerName,
    customerPhone,
    customerInstagram,
    customerEmail,
    customerAddress,
    customerReference: customerReferenceLabel,
    customerOptionId,
    paymentMethod,
    productServiceName,
    productServiceType,
    productServicePrice,
    productServiceOptionId,
    inventoryUsage: inventory.usage,
    inventoryCost: inventory.inventoryCost,
    ...amounts,
    notes,
    category,
    isWarrantyCallback: callback.isWarrantyCallback,
    callbackOf: callback.callbackOf,
    callbackReason: callback.callbackReason,
    refundOf: refund.refundOf,
    status
    }], { session });
    await reconcileInventoryUsage(req.accountId, [], inventory.usage, `Used on record ${entry._id}`, session);
  });

  if (isCompletionStatus(status)) {
    await dispatchWarrantySms(req.accountId, entry);
  }

  return res.status(201).json(entry);
});

export const update = asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }

  const existing = await Entry.findOne({ _id: entryId, accountId: req.accountId });
  if (!existing) {
    return res.status(404).json({ message: "Entry not found." });
  }

  // Captured before the document is mutated below: this is the only point at
  // which the pre-update status is still readable, and it decides whether this
  // save is the transition that starts the warranty.
  const wasComplete = isCompletionStatus(existing.status);

  const type = req.body.type ? String(req.body.type) : existing.type;
  if (!ENTRY_TYPES.includes(type)) {
    return res.status(400).json({ message: `Type must be one of: ${ENTRY_TYPES.join(", ")}.` });
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
    ? await normalizeInventoryUsage(req.accountId, req.body.inventoryUsage)
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
  const suppressSms = bodyHas(req.body, "suppressSms")
    ? Boolean(req.body.suppressSms)
    : !!existing.suppressSms;

  const callback = await resolveCallbackFields(req.accountId, req.body, { selfId: entryId, existing });
  if (callback.error) {
    return res.status(400).json({ message: callback.error });
  }

  let paymentMethod = toPaymentMethod(existing.paymentMethod) || "";
  if (bodyHas(req.body, "paymentMethod")) {
    const rawPaymentMethod = String(req.body.paymentMethod || "").trim();
    const parsedMethod = toPaymentMethod(rawPaymentMethod);
    if (rawPaymentMethod && !parsedMethod) {
      return res.status(400).json({ message: `Payment method must be one of: ${PAYMENT_METHODS.join(", ")}.` });
    }
    paymentMethod = parsedMethod;
  }
  if (status === "Paid" && !paymentMethod && (existing.payments || []).length === 0) {
    return res.status(400).json({ message: "A payment method is required to mark a record as Paid." });
  }

  let customerName = existing.customerName || "";
  let customerPhone = existing.customerPhone || "";
  let customerInstagram = normalizeInstagramHandle(existing.customerInstagram);
  let customerEmail = existing.customerEmail || "";
  let customerAddress = existing.customerAddress || "";
  let customerReferenceLabel = existing.customerReference || "";
  let customerOptionId = existing.customerOptionId ? String(existing.customerOptionId) : null;
  const customerFieldsTouched = ["customerOptionId", "customerName", "customerPhone", "customerInstagram", "customerEmail"]
    .some((field) => bodyHas(req.body, field));

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

  if (bodyHas(req.body, "customerInstagram")) {
    customerInstagram = normalizeInstagramHandle(req.body.customerInstagram);
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
    const customerRefOption = await resolveReferenceOption(req.accountId, "customer", req.body.customerOptionId);
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
      if (!bodyHas(req.body, "customerInstagram")) {
        customerInstagram = "";
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
      const option = customerRefOption.option;
      customerOptionId = customerRefOption.optionId;
      // Typed values win over the stored snapshot; the option fills the blanks.
      customerName = (bodyHas(req.body, "customerName") && customerName) ? customerName : option.name;
      customerPhone = (bodyHas(req.body, "customerPhone") && customerPhone) ? customerPhone : (option.phone || "");
      customerInstagram = (bodyHas(req.body, "customerInstagram") && customerInstagram)
        ? customerInstagram
        : normalizeInstagramHandle(option.instagram);
      customerEmail = (bodyHas(req.body, "customerEmail") && customerEmail) ? customerEmail : (option.email || "");
      customerAddress = (bodyHas(req.body, "customerAddress") && customerAddress) ? customerAddress : (option.address || "");
      customerReferenceLabel = (bodyHas(req.body, "customerReference") && customerReferenceLabel)
        ? customerReferenceLabel
        : (option.reference || "");

      // Backfill contact info the selected customer was missing.
      const fills = {};
      if (customerPhone && !option.phone) fills.phone = customerPhone;
      if (customerInstagram && !option.instagram) fills.instagram = customerInstagram;
      if (customerPhone) fills.phoneKey = normalizePhoneKey(customerPhone);
      if (customerInstagram) fills.instagramKey = normalizeInstagramHandle(customerInstagram);
      if (Object.keys(fills).length > 0) {
        await ReferenceOption.updateOne({ _id: option._id, accountId: req.accountId }, { $set: fills });
      }
    }
  }

  if (!customerOptionId && (customerPhone || customerInstagram)) {
    const customer = await linkOrCreateCustomer(req.accountId, {
      name: customerName,
      phone: customerPhone,
      instagram: customerInstagram,
      email: customerEmail,
      address: customerAddress,
      reference: customerReferenceLabel
    });
    customerOptionId = String(customer._id);
    customerName = customerName || customer.name;
    customerPhone = customerPhone || customer.phone || "";
    customerInstagram = customerInstagram || normalizeInstagramHandle(customer.instagram);
    customerEmail = customerEmail || customer.email || "";
    customerAddress = customerAddress || customer.address || "";
    customerReferenceLabel = customerReferenceLabel || customer.reference || "";
  }

  // Only enforce the customer requirement when this update actually touches
  // customer data, so status/amount tweaks on legacy records keep working.
  if (
    customerFieldsTouched &&
    CUSTOMER_REQUIRED_ENTRY_TYPES.includes(type) &&
    !customerPhone &&
    !customerInstagram
  ) {
    return res.status(400).json({
      message: `A customer phone number or Instagram username is required for ${type} records.`
    });
  }

  if (bodyHas(req.body, "productServiceOptionId")) {
    const productServiceReference = await resolveReferenceOption(req.accountId, "product_service", req.body.productServiceOptionId);
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

  if (!customerName && !customerPhone && !customerInstagram) {
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

  const refund = await resolveRefundOf(req.accountId, req.body, { type, selfId: entryId, existing });
  if (refund.error) {
    return res.status(400).json({ message: refund.error });
  }

  const rawTaxRate = req.body.taxRate !== undefined ? Number(req.body.taxRate) : undefined;
  const taxRate = await resolveRefundTaxRate(req.accountId, refund.refundOf, rawTaxRate);
  const expense = roundMoney(manualExpense + inventory.inventoryCost);
  const amounts = computeAmounts(income, expense, type, taxRate);
  const previousUsage = existing.inventoryUsage ? existing.inventoryUsage.map((item) => item.toObject ? item.toObject() : item) : [];
  await assertInventoryUsageAvailable(req.accountId, previousUsage, inventory.usage);

  existing.date = date;
  existing.type = type;
  existing.description = description;
  existing.income = amounts.income;
  existing.expense = amounts.expense;
  existing.salesTax = amounts.salesTax;
  existing.netProfit = amounts.netProfit;
  existing.customerName = customerName;
  existing.customerPhone = customerPhone;
  existing.customerInstagram = customerInstagram;
  existing.customerEmail = customerEmail;
  existing.customerAddress = customerAddress;
  existing.customerReference = customerReferenceLabel;
  existing.customerOptionId = customerOptionId;
  existing.refundOf = refund.refundOf;
  existing.productServiceName = productServiceName;
  existing.productServiceType = productServiceType;
  existing.productServicePrice = productServicePrice;
  existing.productServiceOptionId = productServiceOptionId;
  existing.inventoryUsage = inventory.usage;
  existing.inventoryCost = inventory.inventoryCost;
  existing.status = status || "Pending";
  existing.paymentMethod = paymentMethod;
  existing.notes = notes;
  existing.category = category;
  existing.isWarrantyCallback = callback.isWarrantyCallback;
  existing.callbackOf = callback.callbackOf;
  existing.callbackReason = callback.callbackReason;
  // Applied before the dispatch below, so unticking the box on the same save
  // that completes the job lets the text go out.
  existing.suppressSms = suppressSms;

  const nowComplete = isCompletionStatus(existing.status);
  const account = await Settings.findById(req.accountId).select("sms").lean();
  if (nowComplete) {
    // Runs on any save while complete, not just the transition, so a record
    // that was completed before this feature existed picks up a warranty code
    // the next time it is touched. assignWarrantyOnCompletion is a no-op once
    // a code exists, so the number and dates never move.
    await assignWarrantyOnCompletion(req.accountId, existing, account?.sms);
  }

  await withTransaction(async (session) => {
    existing.$session(session);
    await existing.save({ session });
    await reconcileInventoryUsage(
      req.accountId,
      previousUsage,
      inventory.usage,
      `Updated record ${existing._id}`,
      session
    );
  });

  // Only the crossing into a finished status texts the customer. Later edits to
  // an already-complete record must stay silent; the SmsMessage unique index is
  // the backstop if this condition is ever wrong.
  if (nowComplete && !wasComplete) {
    await dispatchWarrantySms(req.accountId, existing);
  }

  return res.json(existing);
});

export const remove = asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }

  let deleted;
  await withTransaction(async (session) => {
    deleted = await Entry.findOneAndDelete({ _id: entryId, accountId: req.accountId }, { session });
    if (deleted) {
      await reconcileInventoryUsage(
        req.accountId,
        deleted.inventoryUsage || [],
        [],
        `Deleted record ${deleted._id}`,
        session
      );
      // Any refund that pointed at this record would otherwise reference a
      // record that no longer exists. The refund itself stays — the money did
      // leave — it just loses the link.
      await Entry.updateMany(
        { accountId: req.accountId, refundOf: deleted._id },
        { $set: { refundOf: null } },
        { session }
      );
    }
  });
  if (!deleted) {
    return res.status(404).json({ message: "Entry not found." });
  }
  return res.json({ ok: true });
});

export const addPayment = asyncHandler(async (req, res) => {
  const entryId = String(req.params?.id || "").trim();
  if (!mongoose.Types.ObjectId.isValid(entryId)) {
    return res.status(400).json({ message: "Invalid entry id." });
  }

  const entry = await Entry.findOne({ _id: entryId, accountId: req.accountId });
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

  const method = toPaymentMethod(req.body?.method);
  if (!method) {
    return res.status(400).json({ message: `A payment method is required (${PAYMENT_METHODS.join(", ")}).` });
  }
  const note = String(req.body?.note || "").trim();

  entry.payments.push({ amount: parsedAmount.value, date, method, note, createdAt: new Date() });
  if (!entry.paymentMethod) {
    entry.paymentMethod = method;
  }
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

  const entry = await Entry.findOne({ _id: entryId, accountId: req.accountId });
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
