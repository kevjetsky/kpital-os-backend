import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import * as inventory from "../controllers/inventoryController.js";

const router = Router();

router.get("/", requireAuth, inventory.listItems);
router.post("/", requireAuth, inventory.createItem);
router.get("/:id", requireAuth, inventory.getItem);
router.put("/:id", requireAuth, inventory.updateItem);
router.delete("/:id", requireAuth, inventory.deleteItem);
router.post("/:id/adjust", requireAuth, inventory.adjustQuantity);
router.get("/:id/transactions", requireAuth, inventory.listTransactions);

export default router;
