import { z } from "zod";

const emailField = z.string().trim().toLowerCase().email("A valid email is required.");

export const loginSchema = z.object({
  email: emailField,
  password: z.string().min(1, "Password is required.")
});

export const setupSchema = z.object({
  email: emailField,
  password: z.string().min(4, "Password must be at least 4 characters.")
});

export const verifyEmailSchema = z.object({
  email: emailField,
  code: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits.")
});

export const resendCodeSchema = z.object({ email: emailField });

export const forgotPasswordSchema = z.object({ email: emailField });

export const resetPasswordSchema = z.object({
  email: emailField,
  code: z.string().trim().regex(/^\d{6}$/, "Code must be 6 digits."),
  newPassword: z.string().min(4, "Password must be at least 4 characters.")
});

export const createEntrySchema = z.object({
  type: z.enum(["Repair", "Sales", "Expenses", "Tip"]),
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
  customerInstagram: z.string().optional().default(""),
  customerEmail: z.string().optional().default(""),
  customerAddress: z.string().optional().default(""),
  customerReference: z.string().optional().default(""),
  productServiceName: z.string().optional().default(""),
  productServiceType: z.enum(["product", "service", ""]).optional().default(""),
  productServicePrice: z.number().min(0).optional().default(0)
}).passthrough();
