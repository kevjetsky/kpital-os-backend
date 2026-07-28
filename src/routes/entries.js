import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import * as entries from "../controllers/entriesController.js";
import * as sms from "../controllers/smsController.js";

const router = Router();

router.get("/", requireAuth, entries.list);
router.get("/summary", requireAuth, entries.summary);
router.get("/warranty-candidates", requireAuth, entries.warrantyCandidates);
router.get("/refund-candidates", requireAuth, entries.refundCandidates);
router.get("/callback-stats", requireAuth, entries.callbackStats);
router.post("/", requireAuth, entries.create);
router.put("/:id", requireAuth, entries.update);
router.delete("/:id", requireAuth, entries.remove);
router.get("/:id/sms", requireAuth, sms.listForEntry);
router.post("/:id/sms/resend", requireAuth, sms.resend);
router.post("/:id/payments", requireAuth, entries.addPayment);
router.delete("/:id/payments/:paymentId", requireAuth, entries.deletePayment);

export default router;
