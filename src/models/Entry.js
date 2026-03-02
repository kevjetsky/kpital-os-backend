import mongoose from "mongoose";

const entrySchema = new mongoose.Schema(
  {
    date: { type: Date, required: true },
    type: {
      type: String,
      required: true,
      enum: ["Repair", "Sales", "Expenses"]
    },
    description: { type: String, default: "", trim: true },
    income: { type: Number, required: true, default: 0 },
    expense: { type: Number, required: true, default: 0 },
    salesTax: { type: Number, required: true, default: 0 },
    netProfit: { type: Number, required: true, default: 0 },
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
    notes: { type: String, default: "", trim: true },
    status: {
      type: String,
      required: true,
      enum: ["Pending", "Completed", "Paid"],
      default: "Pending"
    }
  },
  { timestamps: true }
);

entrySchema.index({ date: -1, createdAt: -1 });
entrySchema.index({ type: 1, status: 1, date: -1 });

export const Entry = mongoose.model("Entry", entrySchema);
