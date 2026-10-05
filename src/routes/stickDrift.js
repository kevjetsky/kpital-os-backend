import express, { Router } from "express";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { asyncHandler, toE164US } from "../utils.js";
import { CONTROLLER_MODELS, MAX_QUANTITY, US_STATES, priceCents, siteOrigin, stickDriftReadiness } from "../stickDrift/config.js";
import { STICK_DRIFT_STATUSES, StickDriftError } from "../stickDrift/statusMachine.js";
import * as stickDrift from "../stickDrift/service.js";

// ─── Shared ─────────────────────────────────────────────────────────────────

function handler(fn) {
  return asyncHandler(async (req, res) => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof StickDriftError) {
        return res.status(err.status).json({ message: err.message, code: err.code });
      }
      throw err;
    }
  });
}

// App Engine sets X-Appengine-User-IP itself (clients can't spoof it); req.ip is the proxy there.
function clientIp(req) {
  return req.get("x-appengine-user-ip") || req.ip || "unknown";
}

const returnTrackingSchema = z.object({
  carrier: z.string().trim().min(2, "Enter the carrier.").max(40),
  number: z.string().trim().min(4, "Enter the tracking number.").max(60),
});

const workOrderSchema = z.object({
  customer: z.object({
    firstName: z.string().trim().min(1, "Enter your first name.").max(50),
    lastName: z.string().trim().min(1, "Enter your last name.").max(50),
    phone: z.string().trim().max(30).transform((p, ctx) => {
      const e164 = toE164US(p);
      if (!e164) ctx.addIssue({ code: "custom", message: "Enter a valid US phone number." });
      return e164 || "";
    }),
    email: z.union([z.literal(""), z.string().trim().toLowerCase().email("Enter a valid email.").max(120)]).optional().default(""),
  }),
  returnAddress: z.object({
    street1: z.string().trim().min(3, "Enter your street address.").max(100),
    street2: z.string().trim().max(100).optional().default(""),
    city: z.string().trim().min(2, "Enter your city.").max(60),
    state: z.string().trim().toUpperCase().refine((s) => US_STATES.includes(s), "Choose a US state."),
    zip: z.string().trim().regex(/^\d{5}(-\d{4})?$/, "Enter a valid ZIP code."),
  }),
  controller: z.object({
    model: z.enum(CONTROLLER_MODELS, { message: "Choose a controller model." }),
    quantity: z.number({ message: "Choose how many controllers." }).int().min(1).max(MAX_QUANTITY),
  }),
});

// ─── Public router: /api/public/stick-drift (website, no bearer token) ──────

export const publicStickDriftRouter = Router();

publicStickDriftRouter.use(
  cors({
    origin(origin, cb) {
      cb(null, Boolean(origin) && origin === siteOrigin());
    },
    methods: ["GET", "POST"],
    allowedHeaders: ["Content-Type"],
  })
);
// CORS only stops a browser from reading the response; refuse cross-site writes outright.
publicStickDriftRouter.use((req, res, next) => {
  const origin = req.headers.origin;
  if (req.method === "POST" && origin && origin !== siteOrigin()) {
    return res.status(403).json({ message: "Request origin is not allowed." });
  }
  return next();
});

function limiter(limit) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req)),
    message: { message: "Too many requests. Please wait a few minutes and try again." },
  });
}

export const CREATE_LIMIT = 10;
export const READ_LIMIT = 60;

publicStickDriftRouter.post(
  "/work-orders",
  limiter(CREATE_LIMIT),
  express.json({ limit: "10kb" }),
  validate(workOrderSchema),
  handler(async (req, res) => {
    const workOrder = await stickDrift.createWorkOrder(req.body);
    res.status(201).json({ workOrderNumber: workOrder.workOrderNumber, token: workOrder.token });
  })
);

publicStickDriftRouter.get("/work-orders/:token", limiter(READ_LIMIT), handler(async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(stickDrift.labelView(await stickDrift.getWorkOrderByToken(req.params.token)));
}));

// ─── Admin router: /api/stick-drift (owner bearer auth) ─────────────────────

export const adminStickDriftRouter = Router();

adminStickDriftRouter.use(requireAuth);

adminStickDriftRouter.get("/config", handler(async (_req, res) => {
  res.json({ priceCents: priceCents(), siteUrl: siteOrigin(), readiness: stickDriftReadiness() });
}));

adminStickDriftRouter.get("/work-orders", handler(async (req, res) => {
  res.json(await stickDrift.listWorkOrders(req.accountId, req.query));
}));

adminStickDriftRouter.get("/work-orders/:workOrderNumber", handler(async (req, res) => {
  res.json(await stickDrift.getWorkOrder(req.accountId, req.params.workOrderNumber));
}));

adminStickDriftRouter.delete("/work-orders/:workOrderNumber", handler(async (req, res) => {
  res.json(await stickDrift.deleteWorkOrder(req.accountId, req.params.workOrderNumber));
}));

adminStickDriftRouter.post(
  "/work-orders/:workOrderNumber/status",
  validate(z.object({
    status: z.enum(STICK_DRIFT_STATUSES, { message: "Unknown status." }),
    note: z.string().trim().max(500).optional().default(""),
    returnTracking: returnTrackingSchema.optional(),
  })),
  handler(async (req, res) => {
    res.json(await stickDrift.changeStatus(req.accountId, req.params.workOrderNumber, req.body));
  })
);

adminStickDriftRouter.post(
  "/work-orders/:workOrderNumber/notes",
  validate(z.object({ text: z.string().trim().min(1, "Write a note first.").max(1000) })),
  handler(async (req, res) => {
    res.json(await stickDrift.addNote(req.accountId, req.params.workOrderNumber, req.body.text));
  })
);

adminStickDriftRouter.put(
  "/work-orders/:workOrderNumber/return-tracking",
  validate(returnTrackingSchema),
  handler(async (req, res) => {
    res.json(await stickDrift.setReturnTracking(req.accountId, req.params.workOrderNumber, req.body));
  })
);
