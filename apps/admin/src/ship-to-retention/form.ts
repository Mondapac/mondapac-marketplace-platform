import { MAX_MONTHS, MIN_MONTHS } from './types.ts';

/** The months as typed: a whole number from 1 to 120, or null. */
export function monthsOf(text: string): number | null {
  if (!/^[0-9]{1,3}$/.test(text.trim())) return null;
  const value = Number(text.trim());
  return value >= MIN_MONTHS && value <= MAX_MONTHS ? value : null;
}

/**
 * Whether saving needs the confirm step: deletion is turned on, or it was on and the wait is
 * shortened (more orders become due at once). Turning it off, or lengthening the wait, deletes
 * nothing new.
 */
export function needsConfirm(
  saved: { readonly enabled: boolean; readonly months: number },
  next: { readonly enabled: boolean; readonly months: number },
): boolean {
  if (!next.enabled) return false;
  return !saved.enabled || next.months < saved.months;
}
