import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import * as entries from "../controllers/entriesController.js";

const router = Router();

router.get("/", requireAuth, entries.list);
router.post("/", requireAuth, entries.create);
router.put("/:id", requireAuth, entries.update);
router.delete("/:id", requireAuth, entries.remove);
router.post("/:id/payments", requireAuth, entries.addPayment);
router.delete("/:id/payments/:paymentId", requireAuth, entries.deletePayment);

export default router;
