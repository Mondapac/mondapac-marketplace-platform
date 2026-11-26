import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { ActorContext, Id, Result } from '@mondapac/shared-kernel';
import { OFFER_CHANGE_REASONS, type OfferChangeReason } from '../../domain/events';
import { MAX_DECISION_NOTE_CHARS } from '../../domain/offer-pending-change';
import { isActingAsFor } from '../acting-as';
import type { ValidationFailure } from '../own-reads/own-reads.shared';

/** The answer of a single decision on a post-publication review row. */
export interface OfferPostReviewDecided {
  readonly id: string;
  readonly offerId: string;
  readonly status: 'approved' | 'taken-down';
  readonly version: number;
}

export type OfferPostReviewDecisionFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'post-review.not-found' }
  | { readonly code: 'post-review.not-open' }
  | { readonly code: 'post-review.own-submission' }
  | { readonly code: 'offer.not-live' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

const fail = (path: string, code: string) =>
  err({ code: 'validation.failed', fields: [{ path, code }] } as const);

/** The row id, the version the admin saw and the note (null when absent and optional). */
export interface ParsedPostReviewDecision {
  readonly id: Id<'OfferPostReview'>;
  readonly version: number;
  readonly note: string | null;
}

/**
 * A decision request: the row id and a closed body (`version`, `note`, plus the caller's extra
 * keys). The note is 1 to 2000 characters with something besides white space; `required` refuses
 * its absence. The note's text is never echoed in a refusal.
 */
export function parsePostReviewDecision(
  input: unknown,
  note: 'required' | 'optional',
  extraKeys: readonly string[] = [],
): Result<ParsedPostReviewDecision & { raw: Record<string, unknown> }, ValidationFailure> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return fail('body', 'type');
  }
  const raw = input as Record<string, unknown>;
  const allowed = ['id', 'version', 'note', ...extraKeys];
  for (const key of Object.keys(raw)) {
    if (!allowed.includes(key)) return fail(key, 'unknown');
  }
  const id = typeof raw['id'] === 'string' ? parseId<'OfferPostReview'>(raw['id']) : null;
  if (id === null || !id.ok) return fail('id', 'format');
  const version = raw['version'];
  if (
    typeof version !== 'number' ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > 2147483647
  ) {
    return fail('version', 'type');
  }
  const text = raw['note'];
  if (text === undefined || text === null) {
    if (note === 'required') return fail('note', 'required');
    return ok({ id: id.value, version, note: null, raw });
  }
  if (typeof text !== 'string') return fail('note', 'type');
  if (text.trim().length === 0) return fail('note', 'required');
  if (text.length > MAX_DECISION_NOTE_CHARS) return fail('note', 'length');
  return ok({ id: id.value, version, note: text, raw });
}

/** The take-down's reason code: one of the Offer change reasons. */
export function parseTakeDownReason(value: unknown): Result<OfferChangeReason, ValidationFailure> {
  const known = OFFER_CHANGE_REASONS.find((reason) => reason === value);
  return known === undefined ? fail('reasonCode', 'value') : ok(known);
}

/**
 * True when an admin's decision on a row must be refused as their own (the slice 2c rule): the
 * decider's account is behind one of the Offer's submits (in a Login-as-Seller session that is
 * the admin behind it), or the session acts for the Offer's seller (or names no seller: fail
 * closed).
 */
export function decidesOwnPostReview(
  actor: ActorContext,
  sellerId: Id<'Seller'>,
  submitters: ReadonlySet<Id<'Account'>>,
): boolean {
  if (actor.kind !== 'authenticated') return true;
  return submitters.has(actor.accountId) || isActingAsFor(actor, sellerId);
}
