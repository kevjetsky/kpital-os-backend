import { Router } from "express";
import {
  ENTRY_STATUSES,
  ENTRY_TYPES,
  EXPENSE_CATEGORIES,
  JOB_STATUSES,
  PAYMENT_METHODS,
  PRODUCT_SERVICE_TYPES
} from "../constants.js";

// The lists the API accepts, published once so the dashboard and the MCP server
// read them from here instead of keeping copies that drift. Nothing private, so
// no sign-in is needed.
const router = Router();

router.get("/", (_req, res) => {
  res.set("Cache-Control", "public, max-age=300");
  res.json({
    entryTypes: ENTRY_TYPES,
    expenseCategories: EXPENSE_CATEGORIES,
    paymentMethods: PAYMENT_METHODS,
    statuses: ENTRY_STATUSES,
    jobStatuses: JOB_STATUSES,
    productServiceTypes: PRODUCT_SERVICE_TYPES
  });
});

export default router;
