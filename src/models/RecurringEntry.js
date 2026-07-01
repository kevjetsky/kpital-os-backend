import mongoose from "mongoose";

// A recurring entry is a saved template plus a schedule. On its due date a real
// Entry is materialized from the template (see services/recurringService.js).
const recurringEntrySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },

    // ── Entry template ──────────────────────────────────────────────────────
    type: {
      type: String,
      required: true,
      enum: ["Repair", "Sales", "Expenses", "Tip"]
    },
    description: { type: String, default: "", trim: true },
    income: { type: Number, required: true, default: 0 },
    expense: { type: Number, required: true, default: 0 },
    category: { type: String, default: "", trim: true },
    notes: { type: String, default: "", trim: true },
    customerName: { type: String, default: "", trim: true },
    customerPhone: { type: String, default: "", trim: true },
    customerEmail: { type: String, default: "", trim: true },
    customerAddress: { type: String, default: "", trim: true },
    customerReference: { type: String, default: "", trim: true },
    customerOptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    productServiceName: { type: String, default: "", trim: true },
    productServiceType: {
      type: String,
      enum: ["", "product", "service"],
      default: ""
    },
    productServicePrice: { type: Number, required: true, default: 0 },
    productServiceOptionId: { type: mongoose.Schema.Types.ObjectId, default: null },
    // Status applied to each posted Entry. Recurring bills usually post as Paid.
    status: {
      type: String,
      required: true,
      enum: ["Pending", "Completed", "Paid"],
      default: "Paid"
    },

    // ── Schedule ────────────────────────────────────────────────────────────
    frequency: {
      type: String,
      required: true,
      enum: ["daily", "weekly", "monthly", "yearly"],
      default: "monthly"
    },
    interval: { type: Number, required: true, default: 1, min: 1 },
    startDate: { type: Date, required: true },
    endDate: { type: Date, default: null },
    // The next calendar day on which an occurrence should post.
    nextRunDate: { type: Date, required: true },
    active: { type: Boolean, required: true, default: true },

    // ── Bookkeeping / idempotency ───────────────────────────────────────────
    lastPostedDate: { type: Date, default: null },
    lastEntryId: { type: mongoose.Schema.Types.ObjectId, default: null },
    occurrenceCount: { type: Number, required: true, default: 0 },
    maxOccurrences: { type: Number, default: null }
  },
  { timestamps: true }
);

recurringEntrySchema.index({ active: 1, nextRunDate: 1 });

export const RecurringEntry = mongoose.model("RecurringEntry", recurringEntrySchema);
