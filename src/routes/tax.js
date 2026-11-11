import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import * as tax from "../controllers/taxController.js";

const router = Router();

router.get("/liability", requireAuth, tax.liability);
router.get("/year-end", requireAuth, tax.yearEnd);
router.post("/remittances", requireAuth, tax.createRemittance);
router.delete("/remittances/:id", requireAuth, tax.deleteRemittance);

export default router;
