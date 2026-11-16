import { err, ok } from '@mondapac/shared-kernel';
import type { Id, Result, Temporal } from '@mondapac/shared-kernel';

// The admin's manual customer groups (customers management phase 2, PR 2a): a named list of
// customers kept by hand. Pure: reading a name and a description, and the limits. A group is never
// deleted (a promotion may still name it); it is archived, and an archived group takes no new
// members and is not offered to a promotion.

/** The longest group name, in characters. */
export const GROUP_NAME_MAX = 80;
/** The longest description, in characters. */
export const GROUP_DESCRIPTION_MAX = 500;
/** Groups one Market may have, archived ones included (a list of groups, not a super list). */
export const GROUPS_PER_MARKET_MAX = 500;
/** Customers one add or remove call may name; more goes through "select all matching". */
export const GROUP_BULK_IDS_MAX = 1000;
/** Customers one "select all matching" add or remove may reach (the list's own cap). */
export const GROUP_BULK_MATCHING_MAX = 10_000;

export interface GroupFieldFailure {
  readonly path: string;
  readonly code: string;
}

/** Control characters (a line break included), bidirectional overrides and invisible marks. */
const HIDDEN =
  /[\p{Cc}\u061c\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/u;

/** A group's name: trimmed, 1 to {@link GROUP_NAME_MAX} characters, one line of plain text. */
export function parseGroupName(value: unknown): Result<string, GroupFieldFailure> {
  if (typeof value !== 'string') return err({ path: 'name', code: 'type' });
  const name = value.normalize('NFC').trim();
  if (name.length === 0) return err({ path: 'name', code: 'required' });
  if (Array.from(name).length > GROUP_NAME_MAX) return err({ path: 'name', code: 'too-long' });
  if (HIDDEN.test(name)) return err({ path: 'name', code: 'format' });
  return ok(name);
}

/**
 * A group's description: absent, null or empty is none; else trimmed, at most
 * {@link GROUP_DESCRIPTION_MAX} characters of one line of plain text.
 */
export function parseGroupDescription(value: unknown): Result<string | null, GroupFieldFailure> {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== 'string') return err({ path: 'description', code: 'type' });
  const text = value.normalize('NFC').trim();
  if (text.length === 0) return ok(null);
  if (Array.from(text).length > GROUP_DESCRIPTION_MAX) {
    return err({ path: 'description', code: 'too-long' });
  }
  if (HIDDEN.test(text)) return err({ path: 'description', code: 'format' });
  return ok(text);
}

/** A group as stored. */
export interface CustomerGroup {
  readonly id: Id<'CustomerGroup'>;
  readonly name: string;
  readonly description: string | null;
  readonly kind: 'manual';
  readonly archivedAt: Temporal.Instant | null;
  readonly createdByAccountId: Id<'Account'>;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
  readonly version: number;
}

/** A group with how many customers it holds. */
export interface CustomerGroupWithCount extends CustomerGroup {
  readonly memberCount: number;
}
