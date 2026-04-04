import { z } from "zod";

export const loginSchema = z.object({ password: z.string().min(1, "Password is required.") });

export const setupSchema = z.object({ password: z.string().min(4, "Password must be at least 4 characters.") });

export const createEntrySchema = z.object({
  type: z.enum(["Repair", "Sales", "Expenses"]),
  date: z.string().min(1),
  description: z.string().optional().default(""),
  income: z.number().min(0).optional().default(0),
  expense: z.number().min(0).optional().default(0),
  status: z.enum(["Pending", "Completed", "Paid"]).optional().default("Pending"),
  notes: z.string().optional().default(""),
  customerOptionId: z.string().nullable().optional(),
  productServiceOptionId: z.string().nullable().optional(),
  customerName: z.string().optional().default(""),
  customerPhone: z.string().optional().default(""),
  customerEmail: z.string().optional().default(""),
  customerAddress: z.string().optional().default(""),
  customerReference: z.string().optional().default(""),
  productServiceName: z.string().optional().default(""),
  productServiceType: z.enum(["product", "service", ""]).optional().default(""),
  productServicePrice: z.number().min(0).optional().default(0)
}).passthrough();
