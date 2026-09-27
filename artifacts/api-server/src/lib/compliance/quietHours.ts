/**
 * Calling / texting hours for automated consumer outreach.
 *
 * The federal TCPA rule (47 CFR 64.1200(c)(1)) bars telephone solicitations
 * before 8am or after 9pm at the called party's location, and several states
 * set a narrower window by statute. Automated texts are held until the
 * recipient's local window opens rather than dropped.
 *
 * State windows below are narrower statutory windows we enforce. They are a
 * floor, not legal advice — counsel should review this table whenever a state
 * amends its telemarketing law:
 *   FL  8am–8pm  (Florida Telephone Solicitation Act, Fla. Stat. 501.059)
 *   MD  8am–8pm  (Maryland Stop the Spam Calls Act)
 *   OK  8am–8pm  (Oklahoma Telephone Solicitation Act)
 *   WA  8am–8pm  (RCW 80.36.390)
 *   TX  9am–9pm Mon–Sat, noon–9pm Sunday (Tex. Bus. & Com. Code ch. 301)
 *
 * States spanning more than one time zone are checked in every zone, so a send
 * is only allowed when it is inside the window everywhere in the state. When
 * the recipient's state is unknown we apply the same rule across all
 * continental US zones.
 */

interface Window {
  /** Local hour the window opens (inclusive). */
  start: number;
  /** Local hour the window closes (exclusive). */
  end: number;
  /** Optional Sunday override. */
  sunday?: { start: number; end: number };
}

const FEDERAL_WINDOW: Window = { start: 8, end: 21 };

const STATE_WINDOWS: Record<string, Window> = {
  FL: { start: 8, end: 20 },
  MD: { start: 8, end: 20 },
  OK: { start: 8, end: 20 },
  WA: { start: 8, end: 20 },
  TX: { start: 9, end: 21, sunday: { start: 12, end: 21 } },
};

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const AZ = "America/Phoenix";
const PT = "America/Los_Angeles";
const AK = "America/Anchorage";
const HI = "Pacific/Honolulu";

/** Every IANA zone in use within each state / territory. */
const STATE_ZONES: Record<string, string[]> = {
  AL: [CT], AK: [AK, "America/Adak"], AZ: [AZ], AR: [CT], CA: [PT],
  CO: [MT], CT: [ET], DE: [ET], DC: [ET], FL: [ET, CT], GA: [ET], HI: [HI],
  ID: [MT, PT], IL: [CT], IN: [ET, CT], IA: [CT], KS: [CT, MT], KY: [ET, CT],
  LA: [CT], ME: [ET], MD: [ET], MA: [ET], MI: [ET, CT], MN: [CT], MS: [CT],
  MO: [CT], MT: [MT], NE: [CT, MT], NV: [PT], NH: [ET], NJ: [ET], NM: [MT],
  NY: [ET], NC: [ET], ND: [CT, MT], OH: [ET], OK: [CT], OR: [PT, MT], PA: [ET],
  RI: [ET], SC: [ET], SD: [CT, MT], TN: [ET, CT], TX: [CT, MT], UT: [MT],
  VT: [ET], VA: [ET], WA: [PT], WV: [ET], WI: [CT], WY: [MT],
  PR: ["America/Puerto_Rico"], VI: ["America/St_Thomas"], GU: ["Pacific/Guam"],
  AS: ["Pacific/Pago_Pago"], MP: ["Pacific/Saipan"],
};

const CONTINENTAL_ZONES = [ET, CT, MT, PT];

function localHourAndWeekday(now: Date, timeZone: string): { hour: number; minute: number; weekday: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  }).formatToParts(now);
  return {
    hour: Number(parts.find((p) => p.type === "hour")?.value),
    minute: Number(parts.find((p) => p.type === "minute")?.value),
    weekday: parts.find((p) => p.type === "weekday")?.value ?? "",
  };
}

function withinWindow(now: Date, timeZone: string, window: Window): boolean {
  const { hour, weekday } = localHourAndWeekday(now, timeZone);
  const w = weekday === "Sun" && window.sunday ? window.sunday : window;
  return hour >= w.start && hour < w.end;
}

function resolve(stateCode: string | null | undefined): { zones: string[]; window: Window } {
  const code = stateCode?.trim().toUpperCase() ?? "";
  const zones = STATE_ZONES[code];
  if (!zones) return { zones: CONTINENTAL_ZONES, window: FEDERAL_WINDOW };
  return { zones, window: STATE_WINDOWS[code] ?? FEDERAL_WINDOW };
}

/** True when an automated message may be sent to a recipient in `stateCode` at `now`. */
export function isWithinContactHours(stateCode: string | null | undefined, now: Date): boolean {
  const { zones, window } = resolve(stateCode);
  return zones.every((z) => withinWindow(now, z, window));
}

const STEP_MS = 15 * 60 * 1000;
const HORIZON_MS = 4 * 24 * 60 * 60 * 1000;

/**
 * The earliest instant at or after `now` that is inside the recipient's
 * window, on a 15-minute boundary. Returns `now` itself when already allowed.
 */
export function nextContactWindowStart(stateCode: string | null | undefined, now: Date): Date {
  if (isWithinContactHours(stateCode, now)) return now;
  let t = Math.ceil(now.getTime() / STEP_MS) * STEP_MS;
  const limit = now.getTime() + HORIZON_MS;
  for (; t <= limit; t += STEP_MS) {
    if (isWithinContactHours(stateCode, new Date(t))) return new Date(t);
  }
  // Unreachable for any configured window; fail safe to "tomorrow" rather
  // than sending now.
  return new Date(now.getTime() + 24 * 60 * 60 * 1000);
}
