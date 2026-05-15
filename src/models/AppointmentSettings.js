import mongoose from "mongoose";

const availabilityBlockSchema = new mongoose.Schema(
  {
    startTime: { type: String, required: true, trim: true },
    endTime: { type: String, required: true, trim: true },
    status: { type: String, required: true, enum: ["open", "blocked"], default: "open" }
  },
  { _id: false }
);

const availabilityDaySchema = new mongoose.Schema(
  {
    day: { type: Number, required: true, min: 0, max: 6 },
    blocks: { type: [availabilityBlockSchema], default: [] }
  },
  { _id: false }
);

const dayOverrideSchema = new mongoose.Schema(
  {
    date: { type: String, required: true, trim: true },
    blocks: { type: [availabilityBlockSchema], default: [] },
    reason: { type: String, default: "", trim: true }
  },
  { _id: false }
);

const appointmentSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, default: "main" },
    slotMinutes: { type: Number, required: true, default: 120 },
    bookingHorizonDays: { type: Number, required: true, default: 14 },
    weeklyAvailability: { type: [availabilityDaySchema], default: undefined },
    dayOverrides: { type: [dayOverrideSchema], default: [] }
  },
  { timestamps: true }
);

export const AppointmentSettings = mongoose.model("AppointmentSettings", appointmentSettingsSchema);
