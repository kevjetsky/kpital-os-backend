import mongoose from "mongoose";
import { tenantGuard } from "./tenantGuard.js";

// Sequential invoice numbers per account: INV-1001, INV-1002, ...
// Customers and accountants expect a running number they can quote, not a
// database id. Numbers are never reused, so a deleted record leaves a gap.
const invoiceCounterSchema = new mongoose.Schema(
  {
    accountId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true },
    seq: { type: Number, required: true, default: 0 }
  },
  { collection: "invoiceCounters" }
);
tenantGuard(invoiceCounterSchema, { modelName: "InvoiceCounter" });
export const InvoiceCounter = mongoose.model("InvoiceCounter", invoiceCounterSchema);

const FIRST_INVOICE_NUMBER = 1001;

export function formatInvoiceNumber(seq) {
  return `INV-${FIRST_INVOICE_NUMBER - 1 + seq}`;
}

export async function nextInvoiceNumber(accountId, session = null) {
  const counter = await InvoiceCounter.findOneAndUpdate(
    { accountId },
    { $inc: { seq: 1 } },
    { new: true, upsert: true, setDefaultsOnInsert: true, session }
  );
  return formatInvoiceNumber(counter.seq);
}
