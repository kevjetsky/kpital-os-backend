// Stick Drift configuration, read from env on every call so a change needs no code change.
import mongoose from "mongoose";
import { StickDriftError } from "./statusMachine.js";

export const DEFAULT_PRICE_CENTS = 4999;
export const DEFAULT_RECEIVING_NAME = "We Fix Stick Drift";

export const CONTROLLER_MODELS = ["PS5 DualSense", "Xbox Series X|S"];
// The website form has no cap; this is only a sanity bound against junk submissions.
export const MAX_QUANTITY = 99;

// 50 states + DC.
export const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "DC", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS",
  "KY", "LA", "ME", "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC",
  "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

function normalizeOrigin(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

// The website origin allowed to call the public API. "" means no browser origin is allowed.
export function siteOrigin(env = process.env) {
  const raw = normalizeOrigin(env.SITE_URL);
  if (!raw) return "";
  try {
    return new URL(raw).origin;
  } catch {
    return "";
  }
}

// Pre-tax price per controller, in cents.
export function priceCents(env = process.env) {
  const value = Number(env.PRICE_CENTS);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PRICE_CENTS;
}

// Where customers ship controllers: RECEIVING_ADDRESS is JSON { name, street, city, state, zip }.
// Returns null when unset or incomplete, which blocks new work orders rather than printing a bad label.
export function receivingAddress(env = process.env) {
  if (!env.RECEIVING_ADDRESS) return null;
  let parsed;
  try {
    parsed = JSON.parse(env.RECEIVING_ADDRESS);
  } catch {
    return null;
  }
  const field = (key) => String(parsed?.[key] || "").trim();
  const address = {
    name: field("name") || DEFAULT_RECEIVING_NAME,
    street: field("street"),
    city: field("city"),
    state: field("state").toUpperCase(),
    zip: field("zip"),
  };
  if (!address.street || !address.city || !US_STATES.includes(address.state) || !/^\d{5}(-\d{4})?$/.test(address.zip)) {
    return null;
  }
  return address;
}

// The account that owns work orders created from the website (the form carries no login).
export function stickDriftAccountId(env = process.env) {
  const id = env.STICK_DRIFT_ACCOUNT_ID;
  if (!id || !mongoose.isValidObjectId(id)) {
    throw new StickDriftError("Stick Drift is not configured (STICK_DRIFT_ACCOUNT_ID).", "not_configured", 503);
  }
  return new mongoose.Types.ObjectId(id);
}

// Everything that must be set before the website can take work orders. Empty array means ready.
export function stickDriftReadiness(env = process.env) {
  const problems = [];
  if (!siteOrigin(env)) problems.push("env SITE_URL is not set");
  if (!receivingAddress(env)) problems.push("env RECEIVING_ADDRESS is not set or incomplete");
  if (!env.STICK_DRIFT_ACCOUNT_ID || !mongoose.isValidObjectId(env.STICK_DRIFT_ACCOUNT_ID)) {
    problems.push("env STICK_DRIFT_ACCOUNT_ID is not set");
  }
  return problems;
}
