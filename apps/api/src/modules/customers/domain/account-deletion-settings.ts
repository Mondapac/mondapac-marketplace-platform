import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';

// The Market's buyer account deletion setting (customers package 5a, CUS-03): whether a buyer may
// ask to delete their own account, and how long a request waits before it is carried out. The
// setting ships off; version 0 is these built-in defaults. Package 5b builds the buyer flow on it.

export interface AccountDeletionSettings {
  /** Whether a buyer may start a deletion request. Off until an admin switches it on. */
  readonly enabled: boolean;
  /** Days a request waits before it is carried out. */
  readonly waitingPeriodDays: number;
}

export const SETTING_FIELDS = [
  'enabled',
  'waitingPeriodDays',
] as const satisfies readonly (keyof AccountDeletionSettings)[];

/** Version 0: what is in force before an admin saves anything. */
export const DEFAULT_ACCOUNT_DELETION_SETTINGS: AccountDeletionSettings = Object.freeze({
  enabled: false,
  waitingPeriodDays: 30,
});

export const BOUNDS = Object.freeze({
  waitingPeriodDays: { min: 7, max: 90 },
  reasonLength: 500,
});

export interface FieldError {
  readonly path: string;
  readonly code: 'type' | 'range' | 'format';
}

// Controls, invisible format characters (bidirectional marks, overrides and isolates: a visual
// spoof), line and paragraph separators, and markup characters. The zero-width non-joiner
// (U+200C) stays allowed: Persian text needs it. The database CHECK repeats this list.
const FORBIDDEN_TEXT = /(?!‌)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}<>]/u;

/** Validates a full settings object (every field required, no other key). */
export function parseAccountDeletionSettings(
  input: unknown,
): Result<AccountDeletionSettings, readonly FieldError[]> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return err([{ path: 'settings', code: 'type' }]);
  }
  const raw = input as Record<string, unknown>;
  const errors: FieldError[] = [];
  const { enabled, waitingPeriodDays } = raw;
  if (typeof enabled !== 'boolean') errors.push({ path: 'settings.enabled', code: 'type' });
  if (typeof waitingPeriodDays !== 'number' || !Number.isSafeInteger(waitingPeriodDays)) {
    errors.push({ path: 'settings.waitingPeriodDays', code: 'type' });
  } else if (
    waitingPeriodDays < BOUNDS.waitingPeriodDays.min ||
    waitingPeriodDays > BOUNDS.waitingPeriodDays.max
  ) {
    errors.push({ path: 'settings.waitingPeriodDays', code: 'range' });
  }
  if (errors.length > 0) return err(errors);
  return ok({ enabled: enabled as boolean, waitingPeriodDays: waitingPeriodDays as number });
}

/**
 * The reason for a change as stored: trimmed, NFC, 1 to 500 characters, one line of plain text.
 * It is kept in the insert-only history row only; an audit row and an event carry no free text.
 */
export function parseChangeReason(value: unknown): Result<string, FieldError> {
  if (typeof value !== 'string') return err({ path: 'reason', code: 'type' });
  const text = value.normalize('NFC').trim();
  if (text.length === 0) return err({ path: 'reason', code: 'range' });
  if (FORBIDDEN_TEXT.test(text)) return err({ path: 'reason', code: 'format' });
  if (Array.from(text).length > BOUNDS.reasonLength) return err({ path: 'reason', code: 'range' });
  return ok(text);
}

export function sameSettings(a: AccountDeletionSettings, b: AccountDeletionSettings): boolean {
  return SETTING_FIELDS.every((field) => a[field] === b[field]);
}
