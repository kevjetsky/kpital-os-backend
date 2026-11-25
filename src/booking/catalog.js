// What a customer can book online, and which devices each service is for.
// Liquid metal is PS5 only and stick drift is controllers only; "other" needs a
// description. The website shows the same list (we-fix-consoles BookingFlow).

export const DEVICES = {
  console: {
    ps5: "PS5",
    ps5_slim: "PS5 Slim",
    ps5_pro: "PS5 Pro",
    xbox_series_x: "Xbox Series X",
    xbox_series_s: "Xbox Series S",
    ps4: "PS4",
    xbox_one: "Xbox One",
    other: "Other"
  },
  ps5: { ps5: "PS5", ps5_slim: "PS5 Slim", ps5_pro: "PS5 Pro" },
  controller: { dualsense: "PS5 controller", dualshock4: "PS4 controller", xbox_controller: "Xbox controller", other_controller: "Other controller" }
};

export const SERVICES = {
  hdmi: { label: "HDMI port repair", devices: "console" },
  hdmi_liquid_metal: { label: "HDMI port repair + liquid metal", devices: "ps5" },
  deep_clean: { label: "Full deep clean", devices: "console" },
  deep_clean_liquid_metal: { label: "Full deep clean + liquid metal", devices: "ps5" },
  stick_drift: { label: "Stick drift repair", devices: "controller" },
  fan_connector: { label: "Fan connector repair", devices: "console" },
  other: { label: "Other", devices: "console", describe: true }
};
