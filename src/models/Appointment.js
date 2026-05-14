import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema(
  {
    appointmentDate: { type: String, required: true, trim: true },
    startTime: { type: String, required: true, trim: true },
    endTime: { type: String, required: true, trim: true },
    status: {
      type: String,
      required: true,
      enum: ["requested", "confirmed", "cancelled", "completed"],
      default: "requested"
    },
    customerName: { type: String, required: true, trim: true },
    customerPhone: { type: String, required: true, trim: true },
    customerAddress: { type: String, default: "", trim: true },
    customerEmail: { type: String, default: "", trim: true },
    deviceType: { type: String, required: true, trim: true },
    deviceModel: { type: String, default: "", trim: true },
    issueDescription: { type: String, required: true, trim: true },
    notes: { type: String, default: "", trim: true }
  },
  { timestamps: true }
);

appointmentSchema.index({ appointmentDate: 1, startTime: 1 });
appointmentSchema.index({ status: 1, appointmentDate: 1 });

export const Appointment = mongoose.model("Appointment", appointmentSchema);
