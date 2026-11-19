import express from "express";
import * as receipts from "../controllers/receiptsController.js";
import { MAX_RECEIPT_BYTES } from "../services/receiptService.js";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { accountRateLimiter } from "../middleware/rateLimiter.js";
import { queryFromBody } from "../middleware/queryFromBody.js";
import * as entries from "../controllers/entriesController.js";
import * as insights from "../controllers/insightsController.js";
import * as sms from "../controllers/smsController.js";

const router = Router();

// The route plan prices drives with paid Google Routes calls, like the Slot
// Finder; this caps a runaway client (a refresh loop, a stuck tab).
const routePlanLimiter = accountRateLimiter({ limit: 20, message: "Too many route refreshes. Wait a moment and try again." });

router.get("/", requireAuth, entries.list);
// The same searches with the values in the body, so customer details stay
// out of URLs and Google's request log (see queryFromBody.js).
router.post("/query", requireAuth, queryFromBody, entries.list);
router.post("/warranty-candidates", requireAuth, queryFromBody, entries.warrantyCandidates);
router.post("/refund-candidates", requireAuth, queryFromBody, entries.refundCandidates);
router.get("/summary", requireAuth, entries.summary);
router.get("/warranty-candidates", requireAuth, entries.warrantyCandidates);
router.get("/refund-candidates", requireAuth, entries.refundCandidates);
router.get("/callback-stats", requireAuth, entries.callbackStats);
router.get("/business-statement", requireAuth, entries.businessStatement);
router.get("/area-stats", requireAuth, entries.areaStats);
router.get("/insights", requireAuth, insights.getInsights);
router.get("/today", requireAuth, insights.getToday);
router.get("/related", requireAuth, insights.getRelated);
router.get("/area-points", requireAuth, insights.getAreaPoints);
router.get("/route-plan", requireAuth, routePlanLimiter, insights.getRoutePlan);
// After every fixed path above, so "/summary" and the rest are never read as an id.
router.get("/:id", requireAuth, entries.getOne);
router.post("/", requireAuth, entries.create);
router.put("/:id", requireAuth, entries.update);
router.delete("/:id", requireAuth, entries.remove);
router.get("/:id/sms", requireAuth, sms.listForEntry);
router.post("/:id/sms/resend", requireAuth, sms.resend);
// The photo is the body. express.json (mounted app-wide) leaves image types alone.
router.post(
  "/:id/receipt",
  requireAuth,
  express.raw({ type: ["image/jpeg", "image/png", "image/webp"], limit: MAX_RECEIPT_BYTES }),
  receipts.upload
);
router.get("/:id/receipt", requireAuth, receipts.view);
router.delete("/:id/receipt", requireAuth, receipts.remove);
router.post("/:id/payments", requireAuth, entries.addPayment);
router.delete("/:id/payments/:paymentId", requireAuth, entries.deletePayment);

export default router;
