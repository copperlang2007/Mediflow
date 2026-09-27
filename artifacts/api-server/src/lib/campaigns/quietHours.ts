/**
 * TCPA quiet hours for marketing SMS: only send between 8:00 and 21:00 in the
 * recipient's local time.
 *
 * Contacts carry a US state code but no time zone, so each state maps to its
 * dominant IANA zone. States split across zones (e.g. FL panhandle, TX El
 * Paso, the Dakotas, KY/TN, ID, OR, NE, KS, MI, IN) map to the zone most of
 * their population is in; the narrow 8am–9pm window still leaves the minority
 * inside legal hours for all but the first/last hour of the day. When a
 * contact has no state on file, the org's `campaign_settings.default_time_zone`
 * is used (America/New_York if unset).
 */

export const QUIET_START_HOUR = 21; // 9pm — no sends at or after
export const QUIET_END_HOUR = 8; // 8am — sends allowed from

const STATE_TZ: Record<string, string> = {
  AL: "America/Chicago", AK: "America/Anchorage", AZ: "America/Phoenix",
  AR: "America/Chicago", CA: "America/Los_Angeles", CO: "America/Denver",
  CT: "America/New_York", DE: "America/New_York", DC: "America/New_York",
  FL: "America/New_York", GA: "America/New_York", HI: "Pacific/Honolulu",
  ID: "America/Boise", IL: "America/Chicago", IN: "America/Indiana/Indianapolis",
  IA: "America/Chicago", KS: "America/Chicago", KY: "America/New_York",
  LA: "America/Chicago", ME: "America/New_York", MD: "America/New_York",
  MA: "America/New_York", MI: "America/Detroit", MN: "America/Chicago",
  MS: "America/Chicago", MO: "America/Chicago", MT: "America/Denver",
  NE: "America/Chicago", NV: "America/Los_Angeles", NH: "America/New_York",
  NJ: "America/New_York", NM: "America/Denver", NY: "America/New_York",
  NC: "America/New_York", ND: "America/Chicago", OH: "America/New_York",
  OK: "America/Chicago", OR: "America/Los_Angeles", PA: "America/New_York",
  RI: "America/New_York", SC: "America/New_York", SD: "America/Chicago",
  TN: "America/Chicago", TX: "America/Chicago", UT: "America/Denver",
  VT: "America/New_York", VA: "America/New_York", WA: "America/Los_Angeles",
  WV: "America/New_York", WI: "America/Chicago", WY: "America/Denver",
  PR: "America/Puerto_Rico", VI: "America/St_Thomas", GU: "Pacific/Guam",
  AS: "Pacific/Pago_Pago", MP: "Pacific/Saipan",
};

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function timeZoneForState(
  stateCode: string | null | undefined,
  fallback: string,
): string {
  const tz = stateCode ? STATE_TZ[stateCode.trim().toUpperCase()] : undefined;
  if (tz) return tz;
  return isValidTimeZone(fallback) ? fallback : "America/New_York";
}

export function localHour(at: Date, timeZone: string): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour: "numeric",
    hourCycle: "h23",
  }).format(at);
  return Number(h) % 24;
}

export function isWithinSendWindow(at: Date, timeZone: string): boolean {
  const h = localHour(at, timeZone);
  return h >= QUIET_END_HOUR && h < QUIET_START_HOUR;
}

/** Earliest instant (15-minute resolution) at or after `from` inside the window. */
export function nextSendWindowStart(from: Date, timeZone: string): Date {
  if (isWithinSendWindow(from, timeZone)) return from;
  const stepMs = 15 * 60_000;
  let t = Math.ceil(from.getTime() / stepMs) * stepMs;
  for (let i = 0; i < 4 * 26; i++) {
    const d = new Date(t);
    if (isWithinSendWindow(d, timeZone)) return d;
    t += stepMs;
  }
  return new Date(from.getTime() + 12 * 3_600_000);
}
