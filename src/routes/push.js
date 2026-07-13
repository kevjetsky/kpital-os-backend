import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import * as push from "../controllers/pushController.js";

const router = Router();

router.get("/vapid-public-key", push.vapidPublicKey);
router.post("/subscribe", requireAuth, push.subscribe);
router.post("/unsubscribe", requireAuth, push.unsubscribe);

export default router;
