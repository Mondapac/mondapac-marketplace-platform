import { Temporal } from '@mondapac/shared-kernel';
import { problem } from './fields';
import type { Problems } from './fields';

// The instant an approved post goes live. It is an instant with an offset (`2026-11-03T09:00:00Z`
// or `...+10:00`), later than now and at most a year ahead.

export const MAX_SCHEDULE_DAYS = 366;

export function parseSchedule(
  problems: Problems,
  path: string,
  value: unknown,
  now: Temporal.Instant,
): Temporal.Instant | null {
  if (value === undefined || value === null) {
    problem(problems, path, 'required');
    return null;
  }
  if (typeof value !== 'string' || value.length > 40) {
    problem(problems, path, 'type');
    return null;
  }
  let at: Temporal.Instant;
  try {
    at = Temporal.Instant.from(value);
  } catch {
    problem(problems, path, 'format');
    return null;
  }
  if (Temporal.Instant.compare(at, now) <= 0) {
    problem(problems, path, 'past');
    return null;
  }
  const limit = now.add({ hours: MAX_SCHEDULE_DAYS * 24 });
  if (Temporal.Instant.compare(at, limit) > 0) {
    problem(problems, path, 'too-far');
    return null;
  }
  return at;
}
