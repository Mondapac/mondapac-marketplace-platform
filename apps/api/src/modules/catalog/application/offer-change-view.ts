import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { Id, Result } from '@mondapac/shared-kernel';
import type { OfferHandling } from '../domain/offer';
import {
  MAX_DECISION_NOTE_CHARS,
  type OfferChangeField,
  type OfferChangeSupersededCause,
  type OfferPendingChange,
  type OfferPendingChangeStatus,
} from '../domain/offer-pending-change';
import type { OfferReviewReason } from '../domain/offer-review-policy';

/** A held change of a live Offer as the seller and the reviewer read it (slice 2c). */
export interface OfferChangeView {
  readonly changeId: string;
  readonly offerId: string;
  readonly status: OfferPendingChangeStatus;
  /** The watched fields the change holds. */
  readonly fields: readonly OfferChangeField[];
  readonly proposedDescription: Readonly<Record<string, string>> | null;
  readonly proposedHandling: OfferHandling | null;
  readonly proposedTagTypes: readonly string[];
  readonly reasons: readonly OfferReviewReason[];
  readonly policyVersion: number;
  readonly baseOfferVersion: number;
  readonly submittedAt: string;
  readonly decidedAt: string | null;
  /** The reviewer's note to the seller (request changes, reject); null otherwise. */
  readonly decisionNote: string | null;
  readonly supersededCause: OfferChangeSupersededCause | null;
}

export function offerChangeViewOf(change: OfferPendingChange): OfferChangeView {
  const state = change.state;
  return {
    changeId: state.id,
    offerId: state.offerId,
    status: state.status,
    fields: change.fields,
    proposedDescription: state.proposedDescription,
    proposedHandling: state.proposedHandling,
    proposedTagTypes: state.proposedTagTypes,
    reasons: state.reasons,
    policyVersion: state.policyVersion,
    baseOfferVersion: state.baseOfferVersion,
    submittedAt: state.submittedAt.toString(),
    decidedAt: state.decidedAt === null ? null : state.decidedAt.toString(),
    decisionNote: state.decisionNote,
    supersededCause: state.supersededCause,
  };
}

export interface ChangeValidationFailure {
  readonly code: 'validation.failed';
  readonly fields: readonly { readonly path: string; readonly code: string }[];
}

const invalid = (path: string, code: string): Result<never, ChangeValidationFailure> =>
  err({ code: 'validation.failed', fields: [{ path, code }] });

/**
 * A reviewer's decision on a held change: a closed input with the change id and a note, required
 * (request changes, reject) or optional (approve): 1 to 2000 characters, not only spaces.
 */
export function parseChangeDecision(
  input: unknown,
  note: 'required' | 'optional',
): Result<
  { readonly changeId: Id<'OfferPendingChange'>; readonly note: string | null },
  ChangeValidationFailure
> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return invalid('body', 'type');
  }
  const raw = input as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (key !== 'changeId' && key !== 'note') return invalid(key, 'unknown');
  }
  const id =
    typeof raw['changeId'] === 'string' ? parseId<'OfferPendingChange'>(raw['changeId']) : null;
  if (id === null || !id.ok) return invalid('changeId', 'format');
  const text = raw['note'];
  if (text === undefined || text === null) {
    return note === 'required'
      ? invalid('note', 'required')
      : ok({ changeId: id.value, note: null });
  }
  if (typeof text !== 'string') return invalid('note', 'type');
  if (text.trim().length === 0 || text.length > MAX_DECISION_NOTE_CHARS) {
    return invalid('note', 'length');
  }
  return ok({ changeId: id.value, note: text });
}
