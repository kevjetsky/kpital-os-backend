// Stick Drift work order workflow. The routes (and through them the MCP tools) all call into here.
// Nothing in this module touches entries, inventory, tax or reports: Kev logs the entry by hand.
import crypto from "node:crypto";
import { StickDriftWorkOrder, nextWorkOrderNumber } from "../models/StickDriftWorkOrder.js";
import { priceCents, receivingAddress, stickDriftAccountId } from "./config.js";
import { planTransition, STICK_DRIFT_STATUSES, StickDriftError } from "./statusMachine.js";
import { toAccountObjectId } from "../utils.js";

const MAX_LIST = 200;

function notFound() {
  return new StickDriftError("Work order not found.", "not_found", 404);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ─── Website ────────────────────────────────────────────────────────────────

export async function createWorkOrder(input, { now = new Date() } = {}) {
  if (!receivingAddress()) {
    throw new StickDriftError("Stick Drift is not configured (RECEIVING_ADDRESS).", "not_configured", 503);
  }
  const accountId = stickDriftAccountId();
  const workOrder = new StickDriftWorkOrder({
    accountId,
    workOrderNumber: await nextWorkOrderNumber(accountId),
    token: crypto.randomBytes(32).toString("base64url"),
    customer: input.customer,
    returnAddress: input.returnAddress,
    controller: input.controller,
    priceCents: priceCents() * input.controller.quantity,
    status: "label_created",
    statusHistory: [{ from: null, to: "label_created", at: now, note: "" }],
  });
  await workOrder.save();
  return workOrder;
}

// Only what the shipping label page needs: no phone, email, notes or history.
export function labelView(workOrder) {
  return {
    workOrderNumber: workOrder.workOrderNumber,
    customerName: `${workOrder.customer.firstName} ${workOrder.customer.lastName}`,
    returnAddress: {
      street1: workOrder.returnAddress.street1,
      street2: workOrder.returnAddress.street2,
      city: workOrder.returnAddress.city,
      state: workOrder.returnAddress.state,
      zip: workOrder.returnAddress.zip,
    },
    model: workOrder.controller.model,
    quantity: workOrder.controller.quantity,
    priceCents: workOrder.priceCents,
    status: workOrder.status,
    createdAt: workOrder.createdAt,
    shipTo: receivingAddress(),
  };
}

export async function getWorkOrderByToken(token) {
  // 32 random bytes in base64url is 43 characters; anything else cannot be a real token.
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(token)) throw notFound();
  const workOrder = await StickDriftWorkOrder.findOne({ token }).setOptions({ allowCrossAccount: true });
  if (!workOrder) throw notFound();
  return workOrder;
}

// ─── Owner ──────────────────────────────────────────────────────────────────

export async function getWorkOrder(accountId, workOrderNumber) {
  const workOrder = await StickDriftWorkOrder.findOne({
    accountId,
    workOrderNumber: String(workOrderNumber || "").trim().toUpperCase(),
  });
  if (!workOrder) throw notFound();
  return workOrder;
}

function searchFilter(search) {
  const terms = String(search || "").trim().split(/\s+/).filter(Boolean).slice(0, 5);
  return terms.map((term) => {
    const text = new RegExp(escapeRegex(term), "i");
    const or = [{ workOrderNumber: text }, { "customer.firstName": text }, { "customer.lastName": text }];
    // Phones are stored as +1XXXXXXXXXX, so match on digits however the search was typed.
    const digits = term.replace(/\D+/g, "");
    if (digits.length >= 3) or.push({ "customer.phone": new RegExp(escapeRegex(digits)) });
    return { $or: or };
  });
}

export async function listWorkOrders(accountId, { status, q, limit = 50 } = {}) {
  const filter = { accountId };
  const statuses = String(status || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (statuses.some((s) => !STICK_DRIFT_STATUSES.includes(s))) {
    throw new StickDriftError("Unknown status filter.", "invalid_status", 400);
  }
  if (statuses.length) filter.status = { $in: statuses };
  const terms = searchFilter(q);
  if (terms.length) filter.$and = terms;

  const [workOrders, grouped] = await Promise.all([
    StickDriftWorkOrder.find(filter).sort({ createdAt: -1 }).limit(Math.min(Number(limit) || 50, MAX_LIST)),
    StickDriftWorkOrder.aggregate([
      { $match: { accountId: toAccountObjectId(accountId) } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
  ]);

  // Counts cover every work order on the account, so the tabs stay stable while filtering.
  const counts = Object.fromEntries(STICK_DRIFT_STATUSES.map((s) => [s, 0]));
  for (const row of grouped) counts[row._id] = row.count;
  return { workOrders, counts };
}

// The update is conditional on the status the rules were checked against, so two taps (or the
// dashboard and the MCP at once) cannot both apply a change from the same status.
export async function changeStatus(accountId, workOrderNumber, { status, note = "", returnTracking } = {}, { now = new Date() } = {}) {
  const workOrder = await getWorkOrder(accountId, workOrderNumber);
  const entry = planTransition(workOrder, status, { note, returnTracking, at: now });

  const set = { status: entry.to };
  if (returnTracking) set.returnTracking = returnTracking;
  const updated = await StickDriftWorkOrder.findOneAndUpdate(
    { accountId, workOrderNumber: workOrder.workOrderNumber, status: entry.from },
    { $set: set, $push: { statusHistory: entry } },
    { new: true, runValidators: true }
  );
  if (!updated) {
    throw new StickDriftError("This work order was just changed. Reload and try again.", "conflict", 409);
  }
  return updated;
}

export async function addNote(accountId, workOrderNumber, text, { now = new Date() } = {}) {
  const updated = await StickDriftWorkOrder.findOneAndUpdate(
    { accountId, workOrderNumber: String(workOrderNumber || "").trim().toUpperCase() },
    { $push: { notes: { text, at: now } } },
    { new: true, runValidators: true }
  );
  if (!updated) throw notFound();
  return updated;
}

// Permanent, from any status. The number is not reused (the counter only goes up) and the
// customer's label link stops working.
export async function deleteWorkOrder(accountId, workOrderNumber) {
  const deleted = await StickDriftWorkOrder.findOneAndDelete({
    accountId,
    workOrderNumber: String(workOrderNumber || "").trim().toUpperCase(),
  });
  if (!deleted) throw notFound();
  return { deleted: true, workOrderNumber: deleted.workOrderNumber };
}

export async function setReturnTracking(accountId, workOrderNumber, returnTracking) {
  const updated = await StickDriftWorkOrder.findOneAndUpdate(
    { accountId, workOrderNumber: String(workOrderNumber || "").trim().toUpperCase() },
    { $set: { returnTracking } },
    { new: true, runValidators: true }
  );
  if (!updated) throw notFound();
  return updated;
}
