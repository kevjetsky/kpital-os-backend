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
  withTransaction,
  addUtcDays,
  startOfUtcDay,
  isTaxExemptOn,
  priceForRecord,
  serializeReferenceOption,
  splitName,
  isPlaceholderName
} from "../utils.js";
import { nextInvoiceNumber } from "../models/InvoiceCounter.js";
import { parseAddressText, resolveAddress } from "../services/geoService.js";
import {
  ENTRY_TYPES,
  ENTRY_STATUSES,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  CUSTOMER_REQUIRED_ENTRY_TYPES,
  B2B_ENTRY_TYPES,
  JOB_STATUSES,
  FINISHED_JOB_STATUSES,
  INVOICED_ENTRY_TYPES,
  LINE_ITEM_ENTRY_TYPES,
  MAX_LINE_ITEMS,
  SALES_TAX_RATE,
  MAX_PAYMENT_TERMS_DAYS,
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
    // Remembered so the customer's next record starts with their address (and
    // area) without it being typed again.
    if (address && !match.address) fills.address = address;
    // A customer first saved under their phone number gets their real name once
    // one is typed. A real name already on file is never replaced.
    const namesThem = name && !isPlaceholderName(name, phone, instagram);
    const nameFills =
      namesThem && isPlaceholderName(match.name, match.phone, match.instagram)
        ? { name, normalizedName: normalizeOptionName(name), ...splitName(name) }
        : {};
    if (Object.keys(fills).length > 0 || Object.keys(nameFills).length > 0) {
      try {
        await ReferenceOption.updateOne({ _id: match._id, accountId }, { $set: { ...fills, ...nameFills } });
      } catch (error) {
        // Another customer already has that name; keep the contact fills only.
        if (error?.code !== 11000) throw error;
        await ReferenceOption.updateOne({ _id: match._id, accountId }, { $set: fills });
        return { ...match, ...fills };
      }
    }
    return { ...match, ...fills, ...nameFills };
  }

  const baseName = deriveCustomerName(name, phone, instagram);
  const payload = {
    accountId,
    kind: "customer",
    name: baseName,
    normalizedName: normalizeOptionName(baseName),
    ...(isPlaceholderName(baseName, phone, instagram) ? {} : splitName(baseName)),
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

// B2B: the record is sold to (or refunded to) a saved business rather than a
// walk-in customer. Returns the fields to store, plus the business document when
// this request named one (null when the stored link is simply being kept).
//
// A B2B record always names a business, so a missing or empty businessOptionId
// means "no change", never "remove"; unticking isB2B is how a record leaves B2B.
// That also keeps a record editable after its business was deleted: the link is
// gone but the name snapshot still says who it was for.
const MAX_WORK_ORDER_LENGTH = 60;

async function resolveB2BFields(accountId, body, { type, date, existing = null } = {}) {
  const none = {
    isB2B: false,
    businessOptionId: null,
    businessName: "",
    workOrderNumber: "",
    taxExempt: false,
    paymentTermsDays: 0,
    dueDate: null,
    business: null,
    error: null
  };

  const isB2B = bodyHas(body, "isB2B") ? Boolean(body.isB2B) : Boolean(existing?.isB2B);
  if (!isB2B || !B2B_ENTRY_TYPES.includes(type)) return none;

  const wasB2B = Boolean(existing?.isB2B);
  const previousBusinessId = wasB2B && existing.businessOptionId ? String(existing.businessOptionId) : null;
  let businessOptionId = previousBusinessId;
  let businessName = wasB2B ? existing.businessName || "" : "";
  let business = null;

  const resolved = await resolveReferenceOption(accountId, "business", body?.businessOptionId);
  if (resolved.error) {
    return { ...none, error: resolved.error.includes("not found") ? "Business not found." : "Invalid business id." };
  }
  if (resolved.option) {
    business = resolved.option;
    businessOptionId = resolved.optionId;
    businessName = resolved.option.name;
  }

  if (!businessOptionId && !businessName) {
    return { ...none, error: "Choose the business this B2B record is for." };
  }

  // The business's own work order number for the job. Left out, it keeps what
  // the record already had.
  const workOrderNumber = bodyHas(body, "workOrderNumber")
    ? String(body.workOrderNumber ?? "").trim().slice(0, MAX_WORK_ORDER_LENGTH)
    : wasB2B ? existing.workOrderNumber || "" : "";

  // Unless the request says otherwise, a record keeps its own tax treatment and
  // terms. A record that is only now becoming B2B, or is moving to a different
  // business, takes that business's defaults instead.
  const takesDefaults = !wasB2B || (Boolean(business) && businessOptionId !== previousBusinessId);

  // An expired certificate no longer exempts anything, so the default follows
  // the certificate as of the record's own date. Ticking it by hand still works.
  const taxExempt = bodyHas(body, "taxExempt")
    ? Boolean(body.taxExempt)
    : takesDefaults ? isTaxExemptOn(business, date) : Boolean(existing.taxExempt);

  let paymentTermsDays = takesDefaults ? Number(business?.paymentTermsDays) || 0 : Number(existing.paymentTermsDays) || 0;
  if (bodyHas(body, "paymentTermsDays")) {
    const raw = body.paymentTermsDays;
    paymentTermsDays = raw === null || raw === "" ? 0 : Number(raw);
    if (!Number.isInteger(paymentTermsDays) || paymentTermsDays < 0 || paymentTermsDays > MAX_PAYMENT_TERMS_DAYS) {
      return {
        ...none,
        error: `Payment terms must be a whole number of days from 0 to ${MAX_PAYMENT_TERMS_DAYS}.`
      };
    }
  }

  return {
    isB2B: true,
    businessOptionId,
    businessName,
    workOrderNumber,
    taxExempt,
    paymentTermsDays,
    // No terms means no due date, so the record is never flagged overdue.
    dueDate: paymentTermsDays > 0 ? addUtcDays(date, paymentTermsDays) : null,
    business,
    error: null
  };
}

// On a B2B record the business is the customer: its details fill the customer
// fields so lists, search, receipts and refunds all show who paid. It is never
// linked to (or turned into) a walk-in customer profile.
function businessAsCustomer(business) {
  return {
    customerName: business.name,
    customerPhone: business.phone || "",
    customerInstagram: "",
    customerEmail: business.email || "",
    customerAddress: business.address || "",
    customerReference: ""
  };
}

const ADDRESS_FIELDS = ["addressZip", "addressCity", "addressState", "addressNeighborhood", "addressLat", "addressLng"];
const NO_LOCATION = {
  addressZip: "",
  addressCity: "",
  addressState: "",
  addressNeighborhood: "",
  addressLat: null,
  addressLng: null
};

const zip5 = (value) => (String(value || "").match(/\b\d{5}\b/) || [""])[0];

function cleanCoordinate(value, limit) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= limit ? number : null;
}

// Where the job was, as area fields: ZIP code, city, neighborhood, coordinates.
// `customerAddress` is the address already settled on for the record.
//
// The record form looks the address up as it is picked and sends what it found.
// Anything else (the MCP, an address typed freehand) is looked up here, and when
// that finds nothing the fields fall back to what the text itself says.
async function resolveAddressFields(body, { customerAddress, existing = null, business = null } = {}) {
  const text = String(customerAddress || "").trim();
  if (!text) return { ...NO_LOCATION };

  // What the request found only counts when it is about this very address (the
  // text can also come from the customer's profile) and it actually found
  // something; a form that sends the fields blank has not looked anything up.
  const sentForThisAddress =
    ADDRESS_FIELDS.some((field) => bodyHas(body, field)) && String(body.customerAddress ?? "").trim() === text;
  if (sentForThisAddress) {
    const zip = String(body.addressZip || "").trim();
    const sent = {
      addressZip: /^\d{5}$/.test(zip) ? zip : "",
      addressCity: String(body.addressCity || "").trim().slice(0, 80),
      addressState: String(body.addressState || "").trim().slice(0, 20),
      addressNeighborhood: String(body.addressNeighborhood || "").trim().slice(0, 80),
      addressLat: cleanCoordinate(body.addressLat, 90),
      addressLng: cleanCoordinate(body.addressLng, 180)
    };
    if (sent.addressZip || sent.addressLat !== null) return sent;
  }

  // The same address as before keeps what is already known about it.
  const unchanged = existing && text === String(existing.customerAddress || "").trim();
  if (unchanged && (existing.addressZip || existing.addressLat != null)) {
    return Object.fromEntries(ADDRESS_FIELDS.map((field) => [field, existing[field] ?? NO_LOCATION[field]]));
  }

  const found = await resolveAddress(text);
  if (found) {
    return {
      addressZip: found.zip,
      addressCity: found.city,
      addressState: found.state,
      addressNeighborhood: "",
      addressLat: found.lat,
      addressLng: found.lng
    };
  }

  // On a B2B record the address is the business's own, so its profile fills in
  // what the text does not spell out.
  const parsed = parseAddressText(text);
  return {
    ...NO_LOCATION,
    addressZip: parsed.zip || zip5(business?.postalCode),
    addressCity: parsed.city || business?.city || "",
    addressState: parsed.state || business?.state || ""
  };
}

// ── Job and payment status ─────────────────────────────────────────────────

// A record saved before job status existed reads as In progress while Pending,
// and Done once it was completed or paid.
function jobStatusOf(entry) {
  if (entry?.jobStatus && JOB_STATUSES.includes(entry.jobStatus)) return entry.jobStatus;
  return entry?.status === "Pending" ? "In progress" : "Done";
}

// Job status (where the work stands) and the stored `status`, which is kept in
// step for older callers and the warranty clock: Paid when paid, otherwise
// Completed once the job is Ready or Done, otherwise Pending.
//
// jobStatus sets the work's progress. `status` says whether it is paid; sent on
// its own, as older callers and the MCP do, Completed and Paid also mean the
// work is finished and Pending that it is not.
function resolveStatus(body, { existing = null } = {}) {
  let legacy = null;
  if (bodyHas(body, "status") && body.status !== undefined && body.status !== null && body.status !== "") {
    legacy = toStatus(body.status);
    if (!legacy) return { error: "Status must be Pending, Completed, or Paid." };
  }

  const current = existing ? jobStatusOf(existing) : null;
  let jobStatus;
  if (bodyHas(body, "jobStatus") && body.jobStatus) {
    jobStatus = String(body.jobStatus).trim();
    if (!JOB_STATUSES.includes(jobStatus)) {
      return { error: `Job status must be one of: ${JOB_STATUSES.join(", ")}.` };
    }
  } else if (legacy === "Pending") {
    jobStatus = current && !FINISHED_JOB_STATUSES.includes(current) ? current : "In progress";
  } else if (legacy) {
    jobStatus = current && FINISHED_JOB_STATUSES.includes(current) ? current : "Done";
  } else {
    jobStatus = current || "In progress";
  }

  const paid = legacy ? legacy === "Paid" : bodyHas(body, "paid") ? Boolean(body.paid) : existing?.status === "Paid";
  const status = paid ? "Paid" : FINISHED_JOB_STATUSES.includes(jobStatus) ? "Completed" : "Pending";
  return { jobStatus, status, error: null };
}

// ── Line items ─────────────────────────────────────────────────────────────

const lineTotal = (item) => roundMoney(item.quantity * item.unitPrice);
const itemsTotal = (items) => roundMoney(items.reduce((sum, item) => sum + lineTotal(item), 0));
const plainItems = (items) => (items || []).map((item) => (item.toObject ? item.toObject() : { ...item }));

// What was charged, line by line, on a sale or repair. A line can name a saved
// product/service, whose name and price (its B2B price on a B2B record) fill in
// whatever the line leaves out. `provided` is false when the request did not
// send lines, so the record keeps the ones it has.
async function resolveLineItems(accountId, body, { type, isB2B, existing = null } = {}) {
  if (!LINE_ITEM_ENTRY_TYPES.includes(type)) return { items: [], provided: true, error: null };
  if (!bodyHas(body, "items")) return { items: plainItems(existing?.items), provided: false, error: null };
  if (!Array.isArray(body.items)) {
    return { error: "items must be a list of { productServiceOptionId, name, quantity, unitPrice }." };
  }
  if (body.items.length > MAX_LINE_ITEMS) return { error: `A record can have at most ${MAX_LINE_ITEMS} line items.` };

  const ids = body.items
    .map((item) => String(item?.productServiceOptionId || "").trim())
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  const options = ids.length
    ? await ReferenceOption.find({ accountId, kind: "product_service", _id: { $in: ids } }).lean()
    : [];
  const byId = new Map(options.map((option) => [String(option._id), option]));

  const items = [];
  for (const raw of body.items) {
    const optionId = String(raw?.productServiceOptionId || "").trim();
    if (optionId && !mongoose.Types.ObjectId.isValid(optionId)) return { error: "Invalid product/service id on a line item." };
    const option = optionId ? byId.get(optionId) : null;
    if (optionId && !option) return { error: "A line item's product/service was not found." };

    const name = (String(raw?.name ?? "").trim() || option?.name || "").slice(0, 160);
    if (!name) return { error: "Each line item needs a name or a product/service." };

    const blank = (value) => value === undefined || value === null || value === "";
    const quantity = blank(raw?.quantity) ? 1 : Number(raw.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || quantity > 999) {
      return { error: "A line item's quantity must be more than 0 and at most 999." };
    }
    let unitPrice;
    if (blank(raw?.unitPrice)) {
      unitPrice = option ? priceForRecord(option, isB2B) : 0;
    } else {
      const parsed = parseMoneyInput(raw.unitPrice, "Line item price");
      if (parsed.error) return { error: parsed.error };
      unitPrice = parsed.value;
    }

    items.push({
      productServiceOptionId: option ? option._id : null,
      name,
      optionType: option ? toProductServiceType(option.optionType) : toProductServiceType(raw?.optionType),
      quantity: roundMoney(quantity),
      unitPrice: roundMoney(unitPrice)
    });
  }
  return { items, provided: true, error: null };
}

// ── Device ─────────────────────────────────────────────────────────────────

const DEVICE_FIELDS = { deviceModel: 80, deviceSerial: 60, problemReported: 1000, deviceCondition: 1000, deviceAccessories: 300 };

// Serial numbers are compared as typed on the label: no spaces, upper case.
export function normalizeSerial(value) {
  return String(value || "").toUpperCase().replace(/\s+/g, "").slice(0, DEVICE_FIELDS.deviceSerial);
}

// The customer's device on a sale or repair. Anything the request leaves out
// keeps its stored value.
function readDeviceFields(body, { type, existing = null } = {}) {
  return Object.fromEntries(
    Object.entries(DEVICE_FIELDS).map(([key, limit]) => {
      if (!LINE_ITEM_ENTRY_TYPES.includes(type)) return [key, ""];
      const value = bodyHas(body, key) ? String(body[key] ?? "").trim() : existing?.[key] || "";
      return [key, key === "deviceSerial" ? normalizeSerial(value) : value.slice(0, limit)];
    })
  );
}

// ── Tax rate ───────────────────────────────────────────────────────────────

async function accountTaxRate(accountId) {
  const account = await Settings.findById(accountId).select("salesTaxRate").lean();
  return typeof account?.salesTaxRate === "number" ? account.salesTaxRate : SALES_TAX_RATE;
}

// The rate an existing record was taxed at. Records saved before the rate was
// stored have it worked back from their amounts; the rounding in those is
// smoothed by snapping to the account's rate when it is that close.
function ownTaxRate(entry, accountRate) {
  if (typeof entry?.taxRate === "number") return entry.taxRate;
  if (!entry || entry.taxExempt || !(entry.income > 0) || !(entry.salesTax > 0)) return null;
  const implied = entry.salesTax / entry.income;
  return Math.abs(implied - accountRate) < 0.0005 ? accountRate : Math.min(1, implied);
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

  const SUMMARY_FIELDS = "date description productServiceName type income expense customerName invoiceNumber";
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

// A record is overdue once its due date has passed and it has not been paid.
// Refunds hand money back, so they are never owed.
function overdueFilter(now = new Date()) {
  return {
    dueDate: { $ne: null, $lt: startOfUtcDay(now) },
    status: { $ne: "Paid" },
    type: { $ne: "Refund" }
  };
}

// What the customer was billed and still owes on one record, tax on top.
function billingFor(entry, now = new Date()) {
  const isRefund = entry.type === "Refund";
  const subtotal = roundMoney(isRefund ? -(entry.expense || 0) : entry.income || 0);
  const salesTax = roundMoney(entry.salesTax || 0);
  const total = roundMoney(subtotal + salesTax);
  const payments = roundMoney((entry.payments || []).reduce((sum, payment) => sum + (payment.amount || 0), 0));
  // Marking a record Paid settles it even when no payment lines were logged.
  const settled = isRefund || entry.status === "Paid";
  const balance = settled ? 0 : roundMoney(Math.max(0, total - payments));
  const paid = isRefund ? 0 : entry.status === "Paid" ? total : roundMoney(Math.min(payments, total));
  const overdue = balance > 0 && Boolean(entry.dueDate) && new Date(entry.dueDate) < startOfUtcDay(now);
  return { subtotal, salesTax, total, paid, balance, overdue };
}

// GET /api/entries/business-statement?businessOptionId[&from&to&unpaidOnly]
// One business's B2B records as a single statement: every record in the range
// (or only the unpaid ones) with what was billed, paid and is still owed. The
// dashboard prints this as one invoice for several jobs, and the MCP reads it
// to answer "what does this store owe?".
export const businessStatement = asyncHandler(async (req, res) => {
  const { businessOptionId, from, to, unpaidOnly } = req.query;

  const businessId = String(businessOptionId || "").trim();
  if (!mongoose.Types.ObjectId.isValid(businessId)) {
    return res.status(400).json({ message: "A valid businessOptionId is required." });
  }
  const business = await ReferenceOption.findOne({ _id: businessId, accountId: req.accountId, kind: "business" }).lean();
  if (!business) {
    return res.status(404).json({ message: "Business not found." });
  }

  const query = { accountId: req.accountId, isB2B: true, businessOptionId: businessId };
  const range = {};
  for (const [key, raw] of [["from", from], ["to", to]]) {
    if (!raw) continue;
    const parsed = new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ message: `Invalid ${key} date.` });
    }
    // `to` is inclusive: everything up to the end of that day.
    if (key === "from") range.$gte = startOfUtcDay(parsed);
    else range.$lt = addUtcDays(parsed, 1);
  }
  if (Object.keys(range).length > 0) query.date = range;

  const onlyUnpaid = ["true", "1"].includes(String(unpaidOnly || "").toLowerCase());
  if (onlyUnpaid) {
    query.status = { $ne: "Paid" };
    query.type = { $ne: "Refund" };
  }

  const now = new Date();
  const entries = await Entry.find(query).sort({ date: 1, createdAt: 1 }).lean();
  const totals = { count: entries.length, subtotal: 0, salesTax: 0, total: 0, paid: 0, balance: 0, overdue: 0 };
  const lines = entries.map((entry) => {
    const billing = billingFor(entry, now);
    totals.subtotal = roundMoney(totals.subtotal + billing.subtotal);
    totals.salesTax = roundMoney(totals.salesTax + billing.salesTax);
    totals.total = roundMoney(totals.total + billing.total);
    totals.paid = roundMoney(totals.paid + billing.paid);
    totals.balance = roundMoney(totals.balance + billing.balance);
    if (billing.overdue) totals.overdue = roundMoney(totals.overdue + billing.balance);
    return {
      _id: String(entry._id),
      invoiceNumber: entry.invoiceNumber || "",
      workOrderNumber: entry.workOrderNumber || "",
      date: entry.date,
      type: entry.type,
      status: entry.status,
      description: entry.description || entry.productServiceName || entry.type,
      taxExempt: Boolean(entry.taxExempt),
      paymentTermsDays: Number(entry.paymentTermsDays) || 0,
      dueDate: entry.dueDate || null,
      ...billing
    };
  });

  return res.json({
    business: serializeReferenceOption(business),
    from: range.$gte || null,
    to: to ? startOfUtcDay(new Date(String(to))) : null,
    unpaidOnly: onlyUnpaid,
    generatedAt: now,
    lines,
    totals
  });
});

// The most common non-empty value, so an area is named the way most of its
// records name it.
function mostCommon(values) {
  const counts = new Map();
  for (const value of values) {
    if (value) counts.set(value, (counts.get(value) || 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

// GET /api/entries/area-stats[?from&to]
// Sales and repairs grouped by the ZIP code of the job's address: how many
// jobs, how much revenue and profit, and how many different customers each area
// brought in. Refunds come off the area they were refunded to. Records with no
// address are totalled separately so the coverage of the numbers is visible.
export const areaStats = asyncHandler(async (req, res) => {
  const { from, to } = req.query;
  const query = { accountId: req.accountId, type: { $in: ["Sales", "Repair", "Refund"] } };

  const range = {};
  for (const [key, raw] of [["from", from], ["to", to]]) {
    if (!raw) continue;
    const parsed = new Date(String(raw));
    if (Number.isNaN(parsed.getTime())) {
      return res.status(400).json({ message: `Invalid ${key} date.` });
    }
    if (key === "from") range.$gte = startOfUtcDay(parsed);
    else range.$lt = addUtcDays(parsed, 1);
  }
  if (Object.keys(range).length > 0) query.date = range;

  const entries = await Entry.find(query)
    .select("date type income expense netProfit addressZip addressCity addressNeighborhood customerOptionId businessOptionId")
    .lean();

  const groups = new Map();
  const totals = { jobs: 0, revenue: 0, profit: 0 };
  const noAddress = { jobs: 0, revenue: 0 };
  for (const entry of entries) {
    const isRefund = entry.type === "Refund";
    const revenue = isRefund ? -(entry.expense || 0) : entry.income || 0;
    const jobs = isRefund ? 0 : 1;
    totals.jobs += jobs;
    totals.revenue += revenue;
    totals.profit += entry.netProfit || 0;

    if (!entry.addressZip) {
      noAddress.jobs += jobs;
      noAddress.revenue += revenue;
      continue;
    }
    const group = groups.get(entry.addressZip) || {
      zip: entry.addressZip,
      jobs: 0,
      revenue: 0,
      profit: 0,
      lastDate: null,
      cities: [],
      neighborhoods: [],
      customers: new Set()
    };
    group.jobs += jobs;
    group.revenue += revenue;
    group.profit += entry.netProfit || 0;
    group.cities.push(entry.addressCity);
    group.neighborhoods.push(entry.addressNeighborhood);
    const customer = entry.businessOptionId || entry.customerOptionId;
    if (customer) group.customers.add(String(customer));
    if (!isRefund && (!group.lastDate || entry.date > group.lastDate)) group.lastDate = entry.date;
    groups.set(entry.addressZip, group);
  }

  const located = totals.revenue - noAddress.revenue;
  const areas = Array.from(groups.values())
    .map((group) => ({
      zip: group.zip,
      city: mostCommon(group.cities),
      neighborhood: mostCommon(group.neighborhoods),
      jobs: group.jobs,
      revenue: roundMoney(group.revenue),
      profit: roundMoney(group.profit),
      avgTicket: group.jobs > 0 ? roundMoney(group.revenue / group.jobs) : 0,
      // Share of the revenue that has an address, so the shares add up to 1.
      share: located > 0 ? Number((group.revenue / located).toFixed(4)) : 0,
      customers: group.customers.size,
      lastDate: group.lastDate
    }))
    .sort((a, b) => b.revenue - a.revenue || b.jobs - a.jobs);

  return res.json({
    from: range.$gte || null,
    to: to ? startOfUtcDay(new Date(String(to))) : null,
    areas,
    totals: { jobs: totals.jobs, revenue: roundMoney(totals.revenue), profit: roundMoney(totals.profit) },
    noAddress: { jobs: noAddress.jobs, revenue: roundMoney(noAddress.revenue) }
  });
});

export const list = asyncHandler(async (req, res) => {
  const { type, status, page, limit, search, callbacks, b2b, businessOptionId, overdue, zip, jobStatus } = req.query;
  const query = { accountId: req.accountId };

  // Records saved before job status existed have none; they count by the
  // status they carry, the same way jobStatusOf reads them.
  if (jobStatus) {
    const wanted = String(jobStatus).split(",").map((value) => value.trim()).filter(Boolean);
    if (wanted.some((value) => !JOB_STATUSES.includes(value))) {
      return res.status(400).json({ message: `jobStatus filter must be one of: ${JOB_STATUSES.join(", ")}.` });
    }
    const legacy = [];
    if (wanted.includes("In progress")) legacy.push("Pending");
    if (wanted.includes("Done")) legacy.push("Completed", "Paid");
    query.$and = [
      ...(query.$and || []),
      { $or: [{ jobStatus: { $in: wanted } }, ...(legacy.length ? [{ jobStatus: { $exists: false }, status: { $in: legacy } }] : [])] }
    ];
  }

  if (zip) {
    const zipFilter = String(zip).trim();
    if (!/^\d{5}$/.test(zipFilter)) {
      return res.status(400).json({ message: "zip must be a 5-digit ZIP code." });
    }
    query.addressZip = zipFilter;
  }

  // Combined with $and so it narrows, rather than replaces, a type or status
  // filter given alongside it.
  if (["true", "1"].includes(String(overdue || "").toLowerCase())) {
    query.$and = [...(query.$and || []), ...Object.entries(overdueFilter()).map(([field, condition]) => ({ [field]: condition }))];
  }

  if (b2b !== undefined) {
    const flag = String(b2b).toLowerCase();
    if (flag === "true" || flag === "1") {
      query.isB2B = true;
    } else if (flag === "false" || flag === "0") {
      query.isB2B = { $ne: true };
    }
  }

  if (businessOptionId) {
    const businessFilter = String(businessOptionId).trim();
    if (!mongoose.Types.ObjectId.isValid(businessFilter)) {
      return res.status(400).json({ message: "Invalid businessOptionId." });
    }
    query.businessOptionId = businessFilter;
  }

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
      { customerAddress: searchRegex },
      { addressNeighborhood: searchRegex },
      { invoiceNumber: searchRegex },
      { deviceModel: searchRegex },
      { deviceSerial: searchRegex },
      { problemReported: searchRegex },
      { businessName: searchRegex },
      { workOrderNumber: searchRegex },
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

  const [rangeRows, statusRows, quarterRows, jobRows] = await Promise.all([
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
    ]),
    // Jobs (sales and repairs) whose work is not done, and that are not paid.
    // Expenses are left out: nobody owes the business for them.
    Entry.aggregate([
      { $match: { accountId, type: { $in: ["Sales", "Repair"] } } },
      {
        $project: {
          status: 1,
          jobStatus: { $ifNull: ["$jobStatus", { $cond: [{ $eq: ["$status", "Pending"] }, "In progress", "Done"] }] }
        }
      },
      {
        $group: {
          _id: null,
          open: { $sum: { $cond: [{ $in: ["$jobStatus", ["Booked", "In progress", "Ready"]] }, 1, 0] } },
          unpaid: { $sum: { $cond: [{ $ne: ["$status", "Paid"] }, 1, 0] } }
        }
      }
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
    openJobs: jobRows[0]?.open || 0,
    unpaidJobs: jobRows[0]?.unpaid || 0,
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
  const { customerOptionId, businessOptionId, phone, instagram, date, windowDays, excludeId, serial } = req.query;

  const parsedWindow = windowDays !== undefined ? Number(windowDays) : WARRANTY_DAYS;
  if (!Number.isFinite(parsedWindow) || parsedWindow <= 0 || parsedWindow > 365) {
    return res.status(400).json({ message: "windowDays must be a number between 1 and 365." });
  }

  const referenceDate = date ? new Date(String(date)) : new Date();
  if (Number.isNaN(referenceDate.getTime())) {
    return res.status(400).json({ message: "Invalid date." });
  }

  // A serial number is the console itself, whoever brings it in: the surest
  // sign a repair is coming back.
  const serialNumber = normalizeSerial(serial);

  // A B2B repair belongs to a business, not a customer profile, so its recent
  // jobs are found by the business it was done for.
  const businessId = String(businessOptionId || "").trim();
  if (businessId && !mongoose.Types.ObjectId.isValid(businessId)) {
    return res.status(400).json({ message: "Invalid businessOptionId." });
  }

  let optionId = String(customerOptionId || "").trim();
  if (optionId && !mongoose.Types.ObjectId.isValid(optionId)) {
    return res.status(400).json({ message: "Invalid customerOptionId." });
  }
  if (!serialNumber && !businessId && !optionId) {
    const cleanPhone = String(phone || "").trim();
    const cleanInstagram = normalizeInstagramHandle(instagram);
    if (!cleanPhone && !cleanInstagram) {
      return res.status(400).json({ message: "Provide customerOptionId, businessOptionId, serial, phone, or instagram." });
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
    ...(serialNumber
      ? { deviceSerial: serialNumber }
      : businessId
        ? { businessOptionId: businessId }
        : { customerOptionId: optionId }),
    type: "Repair",
    date: { $gte: windowStart, $lte: referenceDate }
  };
  const cleanExcludeId = String(excludeId || "").trim();
  if (cleanExcludeId && mongoose.Types.ObjectId.isValid(cleanExcludeId)) {
    query._id = { $ne: cleanExcludeId };
  }

  const candidates = await Entry.find(query)
    .sort({ date: -1 })
    .select("date description productServiceName income status isWarrantyCallback callbackOf customerName deviceModel deviceSerial invoiceNumber")
    .lean();

  return res.json({
    windowDays: parsedWindow,
    customerOptionId: serialNumber || businessId ? null : optionId,
    matchedBy: serialNumber ? "serial" : businessId ? "business" : "customer",
    candidates
  });
});

// GET /api/entries/refund-candidates
// Records a refund can point at: anything that actually took money in. Scoped
// to one customer when contact details are known (refunding the person in front
// of you), otherwise the most recent money-in records, searchable by hand for
// the case where the refund is booked without customer details.
export const refundCandidates = asyncHandler(async (req, res) => {
  const { customerOptionId, businessOptionId, phone, instagram, search, excludeId, limit } = req.query;

  const parsedLimit = limit !== undefined ? Number(limit) : 20;
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    return res.status(400).json({ message: "limit must be an integer between 1 and 100." });
  }

  const query = { accountId: req.accountId, income: { $gt: 0 } };

  const businessId = String(businessOptionId || "").trim();
  if (businessId && !mongoose.Types.ObjectId.isValid(businessId)) {
    return res.status(400).json({ message: "Invalid businessOptionId." });
  }

  let optionId = String(customerOptionId || "").trim();
  if (optionId && !mongoose.Types.ObjectId.isValid(optionId)) {
    return res.status(400).json({ message: "Invalid customerOptionId." });
  }
  if (!businessId && !optionId) {
    const cleanPhone = String(phone || "").trim();
    const cleanInstagram = normalizeInstagramHandle(instagram);
    if (cleanPhone || cleanInstagram) {
      const match = await findCustomerByContact(req.accountId, cleanPhone, cleanInstagram);
      optionId = match ? String(match._id) : "";
    }
  }
  if (businessId) {
    query.businessOptionId = businessId;
  } else if (optionId) {
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

// Everything a create or an update decides about a record, from the request
// and (on an update) the record as it stands. A field the request leaves out
// keeps its current value on an update and its default on a create. Returns
// { error } for a request that cannot be saved, or the fields to store.
async function resolveEntryInput(accountId, body, { existing = null, entryId = null } = {}) {
  const has = (key) => bodyHas(body, key);
  const fail = (error) => ({ error });

  const type = body.type ? String(body.type) : existing?.type || "";
  if (!ENTRY_TYPES.includes(type)) {
    return fail(`Type must be one of: ${ENTRY_TYPES.join(", ")}.`);
  }

  const date = body.date ? new Date(body.date) : existing ? existing.date : new Date(NaN);
  if (Number.isNaN(date.getTime())) {
    return fail("Invalid date.");
  }

  const description = has("description") || !existing ? String(body.description || "").trim() : existing.description || "";

  const parsedIncome = body.income !== undefined || !existing
    ? parseMoneyInput(body.income ?? 0, "Income")
    : { value: existing.income, error: null };
  if (parsedIncome.error) return fail(parsedIncome.error);
  const parsedExpense = body.expense !== undefined || !existing
    ? parseMoneyInput(body.expense ?? 0, "Expense")
    : { value: roundMoney((existing.expense || 0) - (existing.inventoryCost || 0)), error: null };
  if (parsedExpense.error) return fail(parsedExpense.error);
  let income = parsedIncome.value;
  const manualExpense = parsedExpense.value;

  // inventoryUsage replaces the parts on the record; addInventoryUsage adds to
  // them, so a caller that only knows the new part does not have to send the
  // whole list back (and cannot drop the others by leaving them out).
  const previousUsage = (existing?.inventoryUsage || []).map((item) => (item.toObject ? item.toObject() : item));
  let inventoryInput;
  if (has("inventoryUsage")) {
    inventoryInput = body.inventoryUsage;
  } else if (has("addInventoryUsage")) {
    if (!Array.isArray(body.addInventoryUsage)) {
      return fail("addInventoryUsage must be a list of { itemId, quantity }.");
    }
    inventoryInput = [
      ...previousUsage.map((item) => ({ itemId: String(item.itemId), quantity: item.quantity })),
      ...body.addInventoryUsage
    ];
  }
  const inventory = inventoryInput !== undefined || !existing
    ? await normalizeInventoryUsage(accountId, inventoryInput)
    : { usage: existing.inventoryUsage || [], inventoryCost: Number(existing.inventoryCost || 0), error: null };
  if (inventory.error) return fail(inventory.error);

  const statuses = resolveStatus(body, { existing });
  if (statuses.error) return fail(statuses.error);
  const { status, jobStatus } = statuses;

  const notes = has("notes") || !existing ? String(body.notes || "").trim() : existing.notes || "";
  const invoiceNote = has("invoiceNote") || !existing
    ? String(body.invoiceNote || "").trim().slice(0, 1000)
    : existing.invoiceNote || "";
  const device = readDeviceFields(body, { type, existing });
  const rawCategory = has("category") || !existing ? String(body.category || "").trim() : existing.category || "";
  const category = type === "Expenses" && EXPENSE_CATEGORIES.includes(rawCategory) ? rawCategory : "";

  const callback = await resolveCallbackFields(accountId, body, { selfId: entryId, existing });
  if (callback.error) return fail(callback.error);

  const b2b = await resolveB2BFields(accountId, body, { type, date, existing });
  if (b2b.error) return fail(b2b.error);
  // The warranty text asks for a review, which reads oddly sent to a store on
  // every unit, so a new B2B record stays quiet unless the request says otherwise.
  const suppressSms = has("suppressSms") ? Boolean(body.suppressSms) : existing ? !!existing.suppressSms : b2b.isB2B;
  // On a B2B record the customer fields come from the business, so whatever the
  // request says about the customer is ignored. A record leaving B2B drops the
  // business's details instead of carrying a store over as a walk-in customer.
  const customerBody = b2b.isB2B ? {} : body;
  const hasCustomer = (key) => bodyHas(customerBody, key);
  const leavingB2B = Boolean(existing?.isB2B) && !b2b.isB2B;

  let paymentMethod = toPaymentMethod(existing?.paymentMethod) || "";
  if (has("paymentMethod")) {
    const rawPaymentMethod = String(body.paymentMethod || "").trim();
    const parsedMethod = toPaymentMethod(rawPaymentMethod);
    if (rawPaymentMethod && !parsedMethod) {
      return fail(`Payment method must be one of: ${PAYMENT_METHODS.join(", ")}.`);
    }
    paymentMethod = parsedMethod;
  }
  if (status === "Paid" && !paymentMethod && (existing?.payments || []).length === 0) {
    return fail("A payment method is required to mark a record as Paid.");
  }

  // ── Customer ──
  const kept = existing && !leavingB2B ? existing : {};
  let customerName = kept.customerName || "";
  let customerPhone = kept.customerPhone || "";
  let customerInstagram = normalizeInstagramHandle(kept.customerInstagram);
  let customerEmail = kept.customerEmail || "";
  let customerAddress = kept.customerAddress || "";
  let customerReferenceLabel = kept.customerReference || "";
  let customerOptionId = !b2b.isB2B && existing?.customerOptionId ? String(existing.customerOptionId) : null;
  if (b2b.business) {
    ({
      customerName,
      customerPhone,
      customerInstagram,
      customerEmail,
      customerAddress,
      customerReference: customerReferenceLabel
    } = businessAsCustomer(b2b.business));
  }
  const customerFieldsTouched = ["customerOptionId", "customerName", "customerPhone", "customerInstagram", "customerEmail"]
    .some(hasCustomer);

  if (hasCustomer("customerName")) {
    customerName = String(customerBody.customerName || "").trim();
    if (!hasCustomer("customerOptionId")) customerOptionId = null;
  }
  if (hasCustomer("customerPhone")) customerPhone = String(customerBody.customerPhone || "").trim();
  if (hasCustomer("customerInstagram")) customerInstagram = normalizeInstagramHandle(customerBody.customerInstagram);
  if (hasCustomer("customerEmail")) customerEmail = String(customerBody.customerEmail || "").trim();
  if (hasCustomer("customerAddress")) customerAddress = String(customerBody.customerAddress || "").trim();
  if (hasCustomer("customerReference")) customerReferenceLabel = String(customerBody.customerReference || "").trim();

  if (hasCustomer("customerOptionId")) {
    const customerRefOption = await resolveReferenceOption(accountId, "customer", customerBody.customerOptionId);
    if (customerRefOption.error) return fail(customerRefOption.error);

    if (!customerRefOption.option) {
      // Unlinked: whatever the request did not restate goes with the link.
      customerOptionId = null;
      if (!hasCustomer("customerName")) customerName = "";
      if (!hasCustomer("customerPhone")) customerPhone = "";
      if (!hasCustomer("customerInstagram")) customerInstagram = "";
      if (!hasCustomer("customerEmail")) customerEmail = "";
      if (!hasCustomer("customerAddress")) customerAddress = "";
      if (!hasCustomer("customerReference")) customerReferenceLabel = "";
    } else {
      const option = customerRefOption.option;
      customerOptionId = customerRefOption.optionId;
      // Typed values win over the stored snapshot; the option fills the blanks.
      const typed = (key, value) => hasCustomer(key) && value;
      customerName = typed("customerName", customerName) ? customerName : option.name;
      customerPhone = typed("customerPhone", customerPhone) ? customerPhone : option.phone || "";
      customerInstagram = typed("customerInstagram", customerInstagram)
        ? customerInstagram
        : normalizeInstagramHandle(option.instagram);
      customerEmail = typed("customerEmail", customerEmail) ? customerEmail : option.email || "";
      customerAddress = typed("customerAddress", customerAddress) ? customerAddress : option.address || "";
      customerReferenceLabel = typed("customerReference", customerReferenceLabel)
        ? customerReferenceLabel
        : option.reference || "";

      // Backfill contact info the selected customer was missing.
      const fills = {};
      if (customerPhone && !option.phone) fills.phone = customerPhone;
      if (customerInstagram && !option.instagram) fills.instagram = customerInstagram;
      if (customerPhone) fills.phoneKey = normalizePhoneKey(customerPhone);
      if (customerInstagram) fills.instagramKey = normalizeInstagramHandle(customerInstagram);
      if (Object.keys(fills).length > 0) {
        await ReferenceOption.updateOne({ _id: option._id, accountId }, { $set: fills });
      }
    }
  }

  if (!b2b.isB2B && !customerOptionId && (customerPhone || customerInstagram)) {
    const customer = await linkOrCreateCustomer(accountId, {
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

  // A new record always needs a way to reach the customer. An update only
  // checks when it touches customer data, so status/amount tweaks on legacy
  // records keep working.
  if (
    !b2b.isB2B &&
    (!existing || customerFieldsTouched) &&
    CUSTOMER_REQUIRED_ENTRY_TYPES.includes(type) &&
    !customerPhone &&
    !customerInstagram
  ) {
    return fail(`A customer phone number or Instagram username is required for ${type} records.`);
  }

  // ── Product/service ──
  let productServiceName = existing?.productServiceName || "";
  let productServiceType = toProductServiceType(existing?.productServiceType);
  let productServicePrice = Number.isFinite(existing?.productServicePrice) ? existing.productServicePrice : 0;
  let productServiceOptionId = existing?.productServiceOptionId ? String(existing.productServiceOptionId) : null;

  if (has("productServiceName")) {
    productServiceName = String(body.productServiceName || "").trim();
    if (!has("productServiceOptionId")) productServiceOptionId = null;
  }
  if (has("productServiceType")) productServiceType = toProductServiceType(body.productServiceType);
  if (has("productServicePrice")) {
    const parsedPrice = parseMoneyInput(body.productServicePrice ?? 0, "Product/service price");
    if (parsedPrice.error) return fail(parsedPrice.error);
    productServicePrice = parsedPrice.value;
  }
  if (has("productServiceOptionId")) {
    const productServiceReference = await resolveReferenceOption(accountId, "product_service", body.productServiceOptionId);
    if (productServiceReference.error) return fail(productServiceReference.error);
    if (!productServiceReference.option) {
      productServiceOptionId = null;
      if (!has("productServiceName")) productServiceName = "";
      if (!has("productServiceType")) productServiceType = "";
      if (!has("productServicePrice")) productServicePrice = 0;
    } else {
      productServiceOptionId = productServiceReference.optionId;
      productServiceName = productServiceReference.option.name;
      productServiceType = toProductServiceType(productServiceReference.option.optionType);
      productServicePrice = priceForRecord(productServiceReference.option, b2b.isB2B);
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

  // ── Line items ──
  const lines = await resolveLineItems(accountId, body, { type, isB2B: b2b.isB2B, existing });
  if (lines.error) return fail(lines.error);
  // A new total with no new lines: one line simply takes the new price; several
  // cannot be split up without being told how.
  if (!lines.provided && lines.items.length > 0 && has("income")) {
    if (lines.items.length > 1) {
      return fail("This record has several line items. Change their prices (items) rather than the total.");
    }
    lines.items[0].unitPrice = roundMoney(income / lines.items[0].quantity);
  }
  if (lines.items.length > 0) {
    // The lines are the price; the record's own product fields name the first
    // one, for the screens and reports that show a single product.
    income = itemsTotal(lines.items);
    const primary = lines.items.find((item) => item.productServiceOptionId) || lines.items[0];
    productServiceName = primary.name;
    productServiceType = primary.optionType;
    productServicePrice = primary.unitPrice;
    productServiceOptionId = primary.productServiceOptionId ? String(primary.productServiceOptionId) : null;
  }

  if (!description && !productServiceName) {
    return fail("Description is required when no product/service is selected.");
  }

  const location = await resolveAddressFields(body, { customerAddress, existing, business: b2b.business });

  const refund = await resolveRefundOf(accountId, body, { type, selfId: entryId, existing });
  if (refund.error) return fail(refund.error);

  // A new record is taxed at the account's rate unless the request names one.
  // An edit keeps the record's own rate, so changing the account's rate later
  // does not quietly re-tax old work.
  const accountRate = await accountTaxRate(accountId);
  const rawTaxRate = body.taxRate !== undefined
    ? Number(body.taxRate)
    : existing ? ownTaxRate(existing, accountRate) ?? accountRate : accountRate;
  const taxRate = await resolveRefundTaxRate(accountId, refund.refundOf, rawTaxRate);
  const expense = roundMoney(manualExpense + inventory.inventoryCost);
  const amounts = computeAmounts(income, expense, type, taxRate, { taxExempt: b2b.taxExempt });
  await assertInventoryUsageAvailable(accountId, previousUsage, inventory.usage);

  return {
    error: null,
    previousUsage,
    values: {
      date,
      type,
      description,
      ...amounts,
      customerName,
      customerPhone,
      customerInstagram,
      customerEmail,
      customerAddress,
      customerReference: customerReferenceLabel,
      customerOptionId,
      ...location,
      isB2B: b2b.isB2B,
      businessOptionId: b2b.businessOptionId,
      businessName: b2b.businessName,
      workOrderNumber: b2b.workOrderNumber,
      taxExempt: b2b.taxExempt,
      paymentTermsDays: b2b.paymentTermsDays,
      dueDate: b2b.dueDate,
      refundOf: refund.refundOf,
      productServiceName,
      productServiceType,
      productServicePrice,
      productServiceOptionId,
      inventoryUsage: inventory.usage,
      inventoryCost: inventory.inventoryCost,
      status,
      jobStatus,
      items: lines.items,
      ...device,
      invoiceNote,
      taxRate: Number.isFinite(taxRate) ? taxRate : SALES_TAX_RATE,
      paymentMethod,
      notes,
      category,
      isWarrantyCallback: callback.isWarrantyCallback,
      callbackOf: callback.callbackOf,
      callbackReason: callback.callbackReason,
      suppressSms
    }
  };
}

// Taken inside the save's transaction, so a save that fails gives its number
// back instead of leaving a gap.
const invoiceNumberFor = (accountId, type, session) =>
  INVOICED_ENTRY_TYPES.includes(type) ? nextInvoiceNumber(accountId, session) : Promise.resolve("");

export const create = asyncHandler(async (req, res) => {
  const input = await resolveEntryInput(req.accountId, req.body ?? {});
  if (input.error) {
    return res.status(400).json({ message: input.error });
  }
  const { values } = input;

  // A record can be booked straight to Completed/Paid (walk-in paid on the
  // spot), so the warranty has to be assigned here too, not only on update.
  const account = await Settings.findById(req.accountId).select("sms").lean();
  const warranty = { warrantyNumber: "", warrantyStartsAt: null, warrantyEndsAt: null };
  if (isCompletionStatus(values.status)) {
    const draft = { type: values.type, warrantyNumber: "" };
    await assignWarrantyOnCompletion(req.accountId, draft, account?.sms);
    warranty.warrantyNumber = draft.warrantyNumber;
    warranty.warrantyStartsAt = draft.warrantyStartsAt || null;
    warranty.warrantyEndsAt = draft.warrantyEndsAt || null;
  }

  let entry;
  await withTransaction(async (session) => {
    const invoiceNumber = await invoiceNumberFor(req.accountId, values.type, session);
    [entry] = await Entry.create([{ accountId: req.accountId, ...values, ...warranty, invoiceNumber }], { session });
    await reconcileInventoryUsage(req.accountId, [], values.inventoryUsage, `Used on record ${entry._id}`, session);
  });

  if (isCompletionStatus(values.status)) {
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

  const input = await resolveEntryInput(req.accountId, req.body ?? {}, { existing, entryId });
  if (input.error) {
    return res.status(400).json({ message: input.error });
  }
  const { values, previousUsage } = input;

  // A new due date is a new deadline, so it earns its own overdue reminder.
  if (String(existing.dueDate || "") !== String(values.dueDate || "")) {
    existing.overdueNotified = false;
  }
  // suppressSms is applied before the dispatch below, so unticking the box on
  // the same save that completes the job lets the text go out.
  Object.assign(existing, values);

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
    // A record that becomes a sale, repair or refund gets its invoice number then.
    if (!existing.invoiceNumber) {
      existing.invoiceNumber = await invoiceNumberFor(req.accountId, existing.type, session);
    }
    existing.$session(session);
    await existing.save({ session });
    await reconcileInventoryUsage(req.accountId, previousUsage, values.inventoryUsage, `Updated record ${existing._id}`, session);
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
