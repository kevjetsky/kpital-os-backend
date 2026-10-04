// Stick Drift work order status rules. planTransition() is the only place a status change is decided.

export const STICK_DRIFT_STATUSES = [
  "label_created",
  "arrived",
  "repaired",
  "paid",
  "shipped_back",
  "delivered",
  "cancelled",
];

export const TRANSITIONS = {
  label_created: ["arrived", "cancelled"],
  arrived: ["repaired", "cancelled"],
  repaired: ["paid"],
  paid: ["shipped_back"],
  shipped_back: ["delivered"],
  delivered: [],
  cancelled: [],
};

export class StickDriftError extends Error {
  constructor(message, code = "stick_drift_error", status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function canTransition(from, to) {
  return (TRANSITIONS[from] || []).includes(to);
}

export function hasReturnTracking(tracking) {
  return Boolean(String(tracking?.carrier || "").trim() && String(tracking?.number || "").trim());
}

// Validates a status change and returns the history entry to append. Does not mutate `order`:
// the caller applies it atomically. `meta.returnTracking` is tracking supplied with this change.
export function planTransition(order, to, meta = {}) {
  const from = order.status;
  if (!STICK_DRIFT_STATUSES.includes(to)) {
    throw new StickDriftError(`Unknown status "${to}".`, "invalid_transition", 400);
  }
  if (!canTransition(from, to)) {
    throw new StickDriftError(`Cannot move a work order from ${from} to ${to}.`, "invalid_transition", 409);
  }
  if (to === "shipped_back" && !hasReturnTracking(meta.returnTracking || order.returnTracking)) {
    throw new StickDriftError("Return tracking (carrier and number) is required before shipping back.", "tracking_required", 409);
  }
  return { from, to, at: meta.at ? new Date(meta.at) : new Date(), note: String(meta.note || "").trim() };
}
