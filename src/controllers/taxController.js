import mongoose from "mongoose";
import { TaxRemittance } from "../models/TaxRemittance.js";
import { asyncHandler, parseMoneyInput } from "../utils.js";
import { getLiability, periodLabel } from "../services/taxService.js";

// GET /api/tax/liability?year=YYYY
// Per-quarter sales tax collected vs. remitted vs. still owed for a year.
export const liability = asyncHandler(async (req, res) => {
  const now = new Date();
  const year = Number.parseInt(String(req.query.year ?? ""), 10) || now.getUTCFullYear();
  const data = await getLiability(year);
  return res.json(data);
});

// POST /api/tax/remittances  { year, quarter, amount, dateFiled?, note? }
// Records a sales-tax filing/payment for a quarter.
export const createRemittance = asyncHandler(async (req, res) => {
  const body = req.body ?? {};

  const year = Number.parseInt(String(body.year ?? ""), 10);
  const quarter = Number.parseInt(String(body.quarter ?? ""), 10);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    return res.status(400).json({ message: "A valid year is required." });
  }
  if (!Number.isInteger(quarter) || quarter < 1 || quarter > 4) {
    return res.status(400).json({ message: "Quarter must be 1–4." });
  }

  const { value: amount, error } = parseMoneyInput(body.amount, "Amount");
  if (error) {
    return res.status(400).json({ message: error });
  }

  const dateFiled = body.dateFiled ? new Date(body.dateFiled) : new Date();
  if (Number.isNaN(dateFiled.getTime())) {
    return res.status(400).json({ message: "dateFiled is not a valid date." });
  }

  const created = await TaxRemittance.create({
    period: periodLabel(year, quarter),
    year,
    quarter,
    amount,
    dateFiled,
    note: String(body.note || "").trim()
  });

  return res.status(201).json({
    _id: String(created._id),
    period: created.period,
    year: created.year,
    quarter: created.quarter,
    amount: created.amount,
    dateFiled: created.dateFiled,
    note: created.note
  });
});

// DELETE /api/tax/remittances/:id
export const deleteRemittance = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid remittance id." });
  }

  const deleted = await TaxRemittance.findByIdAndDelete(id);
  if (!deleted) {
    return res.status(404).json({ message: "Remittance not found." });
  }

  return res.json({ ok: true });
});
