/**
 * Turning "post at 19:00 every day" into actual instants.
 *
 * Done in the operator's time zone rather than the server's, because the
 * question being answered is "when does the audience see it" — and a Mac's
 * clock can be set to anything.
 */
import type { PostEntry, ScheduleSettings } from "./types.js";

/** Posts holding a reel and a slot. A reel cannot be queued twice. */
export const ACTIVE: ReadonlySet<PostEntry["status"]> = new Set(["scheduled", "publishing", "posted"]);

/** The instants already spoken for: a posted post holds the time it actually went out. */
export const takenTimes = (posts: readonly PostEntry[]): string[] =>
  posts.filter((p) => ACTIVE.has(p.status)).map((p) => p.posted_at ?? p.scheduled_at);

/** A slot closer than this to "now" is not offered: Instagram needs time to fetch the video. */
const MIN_LEAD_MS = 5 * 60 * 1000;
const MAX_DAYS_AHEAD = 3660;

function partsIn(date: Date, timeZone: string): Record<string, number> {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  return Object.fromEntries(
    fmt
      .formatToParts(date)
      .filter((p) => p.type !== "literal")
      .map((p) => [p.type, Number(p.value)])
  );
}

/** Milliseconds the zone is ahead of UTC at that instant. */
function offsetMs(date: Date, timeZone: string): number {
  const p = partsIn(date, timeZone);
  return (
    Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) -
    Math.floor(date.getTime() / 1000) * 1000
  );
}

/** "2026-11-06" + "19:00" in Asia/Kolkata → the UTC instant. Re-checks the offset for DST. */
export function zonedTimeToUtc(day: string, time: string, timeZone: string): Date {
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const first = wall - offsetMs(new Date(wall), timeZone);
  return new Date(wall - offsetMs(new Date(first), timeZone));
}

/** Calendar date (YYYY-MM-DD) of an instant in the zone. */
export function localDate(date: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);
}

function addDays(day: string, n: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/**
 * The next `count` free slots after `now`.
 *
 * Each day holds as many posts as there are daily times. A post scheduled by
 * hand at an odd hour still uses up one of its day's places, so adding a
 * one-off never quietly doubles a day.
 */
export function nextFreeSlots(
  settings: Pick<ScheduleSettings, "times" | "timezone">,
  takenIso: readonly string[],
  now: Date,
  count: number
): Date[] {
  const { timezone } = settings;
  const times = [...settings.times].sort();
  const perDay = new Map<string, number>();
  const exact = new Set<number>();
  for (const iso of takenIso) {
    const at = new Date(iso);
    const day = localDate(at, timezone);
    perDay.set(day, (perDay.get(day) ?? 0) + 1);
    exact.add(at.getTime());
  }

  const today = localDate(now, timezone);
  const slots: Date[] = [];
  for (let i = 0; slots.length < count && i < MAX_DAYS_AHEAD; i++) {
    const day = addDays(today, i);
    let used = perDay.get(day) ?? 0;
    for (const time of times) {
      if (slots.length >= count || used >= times.length) break;
      const slot = zonedTimeToUtc(day, time, timezone);
      if (exact.has(slot.getTime())) continue;
      if (slot.getTime() - now.getTime() < MIN_LEAD_MS) continue;
      slots.push(slot);
      used += 1;
    }
  }
  return slots;
}
