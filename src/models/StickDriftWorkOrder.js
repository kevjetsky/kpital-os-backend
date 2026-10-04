import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";
import { STICK_DRIFT_STATUSES } from "../stickDrift/statusMachine.js";
import { CONTROLLER_MODELS, MAX_QUANTITY, US_STATES } from "../stickDrift/config.js";

// A We Fix Stick Drift mail-in work order. Deliberately standalone: it never creates or changes
// entries, inventory, tax or reports. Status only changes through stickDrift/service.changeStatus().
const stickDriftWorkOrderSchema = new mongoose.Schema(
  {
    // Owning account (the Settings _id). Every query must be scoped by this.
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    workOrderNumber: { type: String, required: true },
    // Random 32 bytes, base64url. Public links use this, never the work order number.
    token: { type: String, required: true },
    customer: {
      firstName: { type: String, required: true, trim: true },
      lastName: { type: String, required: true, trim: true },
      phone: { type: String, required: true, trim: true },
      email: { type: String, default: "", trim: true, lowercase: true },
    },
    returnAddress: {
      street1: { type: String, required: true, trim: true },
      street2: { type: String, default: "", trim: true },
      city: { type: String, required: true, trim: true },
      state: { type: String, required: true, enum: US_STATES },
      zip: { type: String, required: true, trim: true },
    },
    controller: {
      model: { type: String, required: true, enum: CONTROLLER_MODELS },
      quantity: { type: Number, required: true, min: 1, max: MAX_QUANTITY },
    },
    // PRICE_CENTS x quantity at creation, pre-tax. Never recomputed.
    priceCents: { type: Number, required: true, min: 0 },
    status: { type: String, required: true, enum: STICK_DRIFT_STATUSES, default: "label_created" },
    statusHistory: [
      {
        _id: false,
        from: { type: String, default: null },
        to: { type: String, required: true },
        at: { type: Date, required: true },
        note: { type: String, default: "" },
      },
    ],
    returnTracking: {
      carrier: { type: String, default: "", trim: true },
      number: { type: String, default: "", trim: true },
    },
    notes: [
      {
        _id: false,
        text: { type: String, required: true, trim: true },
        at: { type: Date, required: true },
      },
    ],
  },
  { timestamps: true, collection: "stickDriftWorkOrders" }
);

stickDriftWorkOrderSchema.index({ accountId: 1, workOrderNumber: 1 }, { unique: true });
stickDriftWorkOrderSchema.index({ accountId: 1, status: 1, createdAt: -1 });
// The public label page looks a work order up by token alone, so this stays unscoped.
stickDriftWorkOrderSchema.index({ token: 1 }, { unique: true });

tenantGuard(stickDriftWorkOrderSchema, { modelName: "StickDriftWorkOrder" });

export const StickDriftWorkOrder = mongoose.model("StickDriftWorkOrder", stickDriftWorkOrderSchema);

// Sequential work order numbers per account: WFSD-1001, WFSD-1002, ...
const stickDriftCounterSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { collection: "stickDriftCounters" }
);
tenantGuard(stickDriftCounterSchema, { modelName: "StickDriftCounter" });
export const StickDriftCounter = mongoose.model("StickDriftCounter", stickDriftCounterSchema);

const FIRST_WORK_ORDER_NUMBER = 1001;

export function formatWorkOrderNumber(seq) {
  return `WFSD-${FIRST_WORK_ORDER_NUMBER - 1 + seq}`;
}

export async function nextWorkOrderNumber(accountId) {
  const counter = await StickDriftCounter.findOneAndUpdate(
    { accountId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true }
  );
  return formatWorkOrderNumber(counter.seq);
}
