import express from "express";
import * as receipts from "../controllers/receiptsController.js";
import { MAX_RECEIPT_BYTES } from "../services/receiptService.js";
import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import * as entries from "../controllers/entriesController.js";
import * as insights from "../controllers/insightsController.js";
import * as sms from "../controllers/smsController.js";

const router = Router();

router.get("/", requireAuth, entries.list);
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
router.get("/route-plan", requireAuth, insights.getRoutePlan);
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
