import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import * as refOpts from "../controllers/referenceOptionsController.js";

const router = Router();

router.get("/", requireAuth, refOpts.list);
router.post("/", requireAuth, refOpts.create);
router.put("/:id", requireAuth, refOpts.update);
router.delete("/:id", requireAuth, refOpts.remove);

export default router;
