import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import app from "../app.js";

let mongod;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  process.env.JWT_SECRET = "test-secret-for-tests-only";
  process.env.MONGODB_URI = mongod.getUri();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.connection.close();
  await mongod.stop();
});

beforeEach(async () => {
  await mongoose.connection.dropDatabase();
});

afterEach(() => {
  delete process.env.RESEND_API_KEY;
  delete process.env.RESEND_FROM_EMAIL;
  vi.restoreAllMocks();
});

async function getToken() {
  await request(app).post("/api/auth/setup").send({ password: "mypassword" });
  const loginRes = await request(app).post("/api/auth/login").send({ password: "mypassword" });
  return loginRes.body.token;
}

describe("appointments", () => {
  it("returns public availability and allows public booking", async () => {
    const availability = await request(app).get("/api/appointments/public/availability?from=2026-05-18&days=1");
    expect(availability.status).toBe(200);
    expect(availability.body.slots[0].date).toBe("2026-05-18");
    expect(availability.body.settings.slotMinutes).toBe(120);
    expect(availability.body.slots[0].slots).toHaveLength(3);
    expect(availability.body.slots[0].slots[0]).toEqual({ startTime: "10:00", endTime: "12:00" });

    const slot = availability.body.slots[0].slots[0];
    const created = await request(app)
      .post("/api/appointments/public")
      .send({
        appointmentDate: "2026-05-18",
        startTime: slot.startTime,
        customerName: "Avery Console",
        customerPhone: "555-1000",
        customerAddress: "123 Main St",
        customerEmail: "avery@example.com",
        deviceType: "PS5",
        issueDescription: "HDMI port is loose"
      });

    expect(created.status).toBe(201);
    expect(created.body.status).toBe("requested");
    expect(created.body.customerAddress).toBe("123 Main St");
    expect(created.body.customerEmail).toBe("avery@example.com");
    expect(created.body.deviceModel).toBe("");

    const conflict = await request(app)
      .post("/api/appointments/public")
      .send({
        appointmentDate: "2026-05-18",
        startTime: slot.startTime,
        customerName: "Morgan",
        customerPhone: "555-2000",
        customerAddress: "456 Oak Ave",
        deviceType: "Xbox",
        issueDescription: "No power"
      });
    expect(conflict.status).toBe(409);
  });

  it("requires auth to manage appointments and settings", async () => {
    const unauthenticated = await request(app).get("/api/appointments");
    expect(unauthenticated.status).toBe(401);

    const token = await getToken();
    const settings = await request(app)
      .put("/api/appointments/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        slotMinutes: 60,
        bookingHorizonDays: 7,
        weeklyAvailability: [
          { day: 1, enabled: true, startTime: "09:00", endTime: "12:00" }
        ],
        dayBlocks: [{ date: "2026-05-19", reason: "Closed" }]
      });
    expect(settings.status).toBe(200);
    expect(settings.body.slotMinutes).toBe(60);
    expect(settings.body.dayBlocks).toHaveLength(1);

    const availability = await request(app).get("/api/appointments/public/availability?from=2026-05-18&days=2");
    expect(availability.body.slots[0].slots).toHaveLength(3);
    expect(availability.body.slots[1].slots).toHaveLength(0);
  });

  it("preserves existing availability and blocks when settings are partially updated", async () => {
    const token = await getToken();

    const initial = await request(app)
      .put("/api/appointments/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        slotMinutes: 60,
        bookingHorizonDays: 10,
        weeklyAvailability: [
          { day: 1, enabled: true, startTime: "09:00", endTime: "11:00" }
        ],
        dayBlocks: [{ date: "2026-05-20", reason: "Closed" }]
      });
    expect(initial.status).toBe(200);

    const updated = await request(app)
      .put("/api/appointments/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ bookingHorizonDays: 12 });

    expect(updated.status).toBe(200);
    expect(updated.body.bookingHorizonDays).toBe(12);
    expect(updated.body.slotMinutes).toBe(60);
    expect(updated.body.weeklyAvailability.find((item) => item.day === 1)).toMatchObject({
      enabled: true,
      startTime: "09:00",
      endTime: "11:00"
    });
    expect(updated.body.dayBlocks).toEqual([{ date: "2026-05-20", startTime: "", endTime: "", reason: "Closed" }]);
  });

  it("hides and rejects appointments that overlap manual time blocks", async () => {
    const token = await getToken();
    const settings = await request(app)
      .put("/api/appointments/settings")
      .set("Authorization", `Bearer ${token}`)
      .send({
        slotMinutes: 120,
        bookingHorizonDays: 7,
        weeklyAvailability: [
          { day: 1, enabled: true, startTime: "10:00", endTime: "17:00" }
        ],
        dayBlocks: [{ date: "2026-05-18", startTime: "12:00", endTime: "14:00", reason: "Lunch" }]
      });
    expect(settings.status).toBe(200);
    expect(settings.body.dayBlocks[0]).toMatchObject({
      date: "2026-05-18",
      startTime: "12:00",
      endTime: "14:00"
    });

    const availability = await request(app).get("/api/appointments/public/availability?from=2026-05-18&days=1");
    expect(availability.body.slots[0].slots).toEqual([
      { startTime: "10:00", endTime: "12:00" },
      { startTime: "14:00", endTime: "16:00" }
    ]);

    const blocked = await request(app)
      .post("/api/appointments/public")
      .send({
        appointmentDate: "2026-05-18",
        startTime: "12:00",
        customerName: "Blocked Customer",
        customerPhone: "555-3333",
        customerAddress: "789 Pine Rd",
        deviceType: "PS5",
        issueDescription: "No signal"
      });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toBe("That time is blocked.");
  });

  it("sends a confirmation email when an appointment is confirmed", async () => {
    process.env.RESEND_API_KEY = "re_test_key";
    process.env.RESEND_FROM_EMAIL = "Kpital OS <appointments@example.com>";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ id: "email_123" })
    });

    const token = await getToken();
    const created = await request(app)
      .post("/api/appointments/public")
      .send({
        appointmentDate: "2026-05-18",
        startTime: "10:00",
        customerName: "Email Customer",
        customerPhone: "555-4444",
        customerAddress: "900 Email St",
        customerEmail: "customer@example.com",
        deviceType: "Switch",
        issueDescription: "Fan noise"
      });

    const confirmed = await request(app)
      .patch(`/api/appointments/${created.body._id}`)
      .set("Authorization", `Bearer ${token}`)
      .send({ status: "confirmed" });

    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmationEmail).toEqual({ sent: true, id: "email_123" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.resend.com/emails",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer re_test_key" })
      })
    );
    const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(payload.from).toBe("Kpital OS <appointments@example.com>");
    expect(payload.to).toEqual(["customer@example.com"]);
    expect(payload.subject).toContain("Appointment confirmed");
  });
});
