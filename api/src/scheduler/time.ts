/**
 * Dates and working hours in a client's own time zone.
 *
 * The database stores UTC. Clients work in local time (Asia/Riyadh by
 * default), so "every 2 days during working hours" is worked out on the
 * local calendar and turned back into UTC here.
 */

export interface WorkingWindow {
  working_hours_start: string; // "09:00" or "09:00:00"
  working_hours_end: string;
  working_days: number[]; // 0 = Sunday ... 6 = Saturday
  timezone: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

function parts(date: Date, timeZone: string) {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (t: string) => Number(p.find((x) => x.type === t)?.value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** Local calendar date, "YYYY-MM-DD". */
export function localDate(date: Date, timeZone: string): string {
  const { y, m, d } = parts(date, timeZone);
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Local clock time, "HH:MM". */
export function localTime(date: Date, timeZone: string): string {
  const { h, mi } = parts(date, timeZone);
  return `${pad(h)}:${pad(mi)}`;
}

/** "YYYY-MM-DD" plus n calendar days. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

/** Day of the week of a "YYYY-MM-DD" date, 0 = Sunday. */
export function weekday(day: string): number {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** The moment (UTC) when the clock shows `time` on `day` in `timeZone`. */
export function zonedTime(day: string, time: string, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const [h, mi] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, h, mi);
  // Guess with the offset at that moment, then correct once (enough for daylight saving changes).
  let guess = wall - offsetMs(new Date(wall), timeZone);
  guess = wall - offsetMs(new Date(guess), timeZone);
  return new Date(guess);
}

function offsetMs(date: Date, timeZone: string): number {
  const { y, m, d, h, mi, s } = parts(date, timeZone);
  return Date.UTC(y, m - 1, d, h, mi, s) - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * The first moment at or after `from` that is inside working hours.
 * `from` itself if it already is.
 */
export function nextWorkingTime(from: Date, w: WorkingWindow): Date {
  const start = w.working_hours_start.slice(0, 5);
  const end = w.working_hours_end.slice(0, 5);
  const today = localDate(from, w.timezone);
  for (let i = 0; i < 15; i++) {
    const day = addDays(today, i);
    if (!w.working_days.includes(weekday(day))) continue;
    const open = zonedTime(day, start, w.timezone);
    const close = zonedTime(day, end, w.timezone);
    if (from < open) return open;
    if (from < close) return from;
  }
  throw new Error('No working day in the next two weeks: check working_days');
}

/** The same local clock time `days` calendar days later, moved into working hours. */
export function afterDays(from: Date, days: number, w: WorkingWindow): Date {
  const later = zonedTime(addDays(localDate(from, w.timezone), days), localTime(from, w.timezone), w.timezone);
  return nextWorkingTime(later, w);
}

/** Later of two moments; undefined values are ignored. */
export function latest(...dates: (Date | null | undefined)[]): Date | undefined {
  let best: Date | undefined;
  for (const d of dates) if (d && (!best || d > best)) best = d;
  return best;
}
