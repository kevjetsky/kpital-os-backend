import mongoose from "mongoose";

const availabilityWindowSchema = new mongoose.Schema(
  {
    day: { type: Number, required: true, min: 0, max: 6 },
    enabled: { type: Boolean, required: true, default: false },
    startTime: { type: String, required: true, default: "10:00", trim: true },
    endTime: { type: String, required: true, default: "17:00", trim: true }
  },
  { _id: false }
);

const dayBlockSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, trim: true },
    startTime: { type: String, default: "", trim: true },
    endTime: { type: String, default: "", trim: true },
    reason: { type: String, default: "", trim: true }
  },
  { _id: false }
);

const appointmentSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "main" },
    slotMinutes: { type: Number, required: true, default: 120 },
    bookingHorizonDays: { type: Number, required: true, default: 14 },
    weeklyAvailability: { type: [availabilityWindowSchema], default: undefined },
    dayBlocks: { type: [dayBlockSchema], default: [] }
  },
  { timestamps: true }
);

export const AppointmentSettings = mongoose.model("AppointmentSettings", appointmentSettingsSchema);
