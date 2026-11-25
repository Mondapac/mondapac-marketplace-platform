// How long a row has waited, as the parts a message turns into words ("3d 4h", "5h 10m", "12m").
// Pure: the caller passes the instants (never the clock, ADR-0005).

export type WaitingAge =
  | { readonly key: 'days'; readonly days: number; readonly hours: number }
  | { readonly key: 'hours'; readonly hours: number; readonly minutes: number }
  | { readonly key: 'minutes'; readonly minutes: number };

/** The wait from `since` to `now`; a time in the future counts as no wait. */
export function waitingAge(since: string, now: Date): WaitingAge | null {
  const start = Date.parse(since);
  if (Number.isNaN(start)) return null;
  const minutes = Math.max(0, Math.floor((now.getTime() - start) / 60_000));
  if (minutes >= 1440) {
    return {
      key: 'days',
      days: Math.floor(minutes / 1440),
      hours: Math.floor((minutes % 1440) / 60),
    };
  }
  if (minutes >= 60)
    return { key: 'hours', hours: Math.floor(minutes / 60), minutes: minutes % 60 };
  return { key: 'minutes', minutes };
}
