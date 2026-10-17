import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { RELAXATION_SUBJECTS } from './events';
import { assertSecondAdmin } from './type-revision';
import type { ExpertApproval } from './issuer';

// The registry rules of certification slice 12 (design 3.5, 3.6, 3.7, 7.6; H1): the fields of an
// issuer, the optional admin change reason, the type's status transitions and the closing of a
// pending relaxation proposal. Pure functions: the use cases bring the stored state, the actor's
// account id and the clock.

export const MAX_ISSUER_NAME_LENGTH = 200;
export const MAX_ACCREDITATION_NUMBER_LENGTH = 64;
export const MAX_EXPERT_CONFIRMED_BY_LENGTH = 120;
export const MAX_EXPERT_REFERENCE_LENGTH = 300;
/** Design 3.7 (Hadi's ruling): at most 500 characters, admin-written, no seller data. */
export const MAX_CHANGE_REASON_LENGTH = 500;

export type FieldAnswer<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: string };

/** The characters the database's S7 CHECK refuses, plus markup brackets (rendered inert anyway). */
const LINE_BREAK = /[\n\r\t\u2028\u2029]/u;
const MARKUP = /[<>]/u;

function textIn(
  value: unknown,
  max: number,
  options: { readonly optional: boolean; readonly multiline: boolean },
): FieldAnswer<string | null> {
  if (value === undefined || value === null) {
    return options.optional ? { ok: true, value: null } : { ok: false, code: 'required' };
  }
  if (typeof value !== 'string') return { ok: false, code: 'type' };
  const text = value.trim();
  if (text.length === 0) {
    return options.optional ? { ok: true, value: null } : { ok: false, code: 'required' };
  }
  if (Array.from(text).length > max) return { ok: false, code: 'too-long' };
  if (!parsePlainText(text).ok) return { ok: false, code: 'invalid-character' };
  if (!options.multiline && (LINE_BREAK.test(text) || MARKUP.test(text))) {
    return { ok: false, code: 'invalid-character' };
  }
  return { ok: true, value: text };
}

/** A public issuer name (data design 3.7): one trimmed line of 1 to 200 characters. */
export function issuerNameIn(value: unknown): FieldAnswer<string> {
  return textIn(value, MAX_ISSUER_NAME_LENGTH, {
    optional: false,
    multiline: false,
  }) as FieldAnswer<string>;
}

/**
 * The uniqueness key of an issuer name within its type (data design 3.7, D 16.1): NFKC, case
 * folded, inner whitespace collapsed, so two registry entries a seller cannot tell apart collide
 * on the unique index. NFKC again after folding, as the CHECK requires a normalised key.
 */
export function issuerNameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** The optional public accreditation reference (data design 3.7): one line, 1 to 64 characters. */
export function accreditationNumberIn(value: unknown): FieldAnswer<string | null> {
  return textIn(value, MAX_ACCREDITATION_NUMBER_LENGTH, { optional: true, multiline: false });
}

/**
 * The expert approval reference of an issuer (brief s5, AC 19): who confirmed and a document or
 * note reference. Both required, one line each. It may name a person, so it is sealed under the
 * Market's platform key (CE7) and never logged.
 */
export function expertApprovalIn(
  value: unknown,
): { ok: true; value: ExpertApproval } | { ok: false; path: string; code: string } {
  if (value === undefined || value === null) return { ok: false, path: '', code: 'required' };
  if (typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, path: '', code: 'type' };
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'confirmedBy' && key !== 'reference') {
      return { ok: false, path: key.slice(0, 64), code: 'unknown-field' };
    }
  }
  const confirmedBy = textIn(record.confirmedBy, MAX_EXPERT_CONFIRMED_BY_LENGTH, {
    optional: false,
    multiline: false,
  });
  if (!confirmedBy.ok) return { ok: false, path: 'confirmedBy', code: confirmedBy.code };
  const reference = textIn(record.reference, MAX_EXPERT_REFERENCE_LENGTH, {
    optional: false,
    multiline: false,
  });
  if (!reference.ok) return { ok: false, path: 'reference', code: reference.code };
  return { ok: true, value: { confirmedBy: confirmedBy.value!, reference: reference.value! } };
}

/**
 * The optional change reason of a type revision or a reactivation (design 3.7, Q-C9): plain text
 * of at most 500 characters, line breaks allowed. Blank is "no reason". It is stored only as a
 * ciphertext under its own key (CE8) and never reaches an event, an audit row or a log.
 */
export function changeReasonIn(value: unknown): FieldAnswer<string | null> {
  return textIn(value, MAX_CHANGE_REASON_LENGTH, { optional: true, multiline: true });
}

export type TypeStatus = 'active' | 'inactive';

export type TypeStatusProblem =
  { readonly code: 'type.already-inactive' } | { readonly code: 'type.already-active' };

/** `active` → `inactive` by `type.edit`, at once (design 3.6; CERT-03). */
export function deactivateType(status: TypeStatus): Result<TypeStatus, TypeStatusProblem> {
  return status === 'active' ? ok('inactive') : err({ code: 'type.already-inactive' });
}

/** Only an `inactive` type can be proposed for reactivation (design 3.6; H1). */
export function requestTypeReactivation(status: TypeStatus): Result<true, TypeStatusProblem> {
  return status === 'inactive' ? ok(true) : err({ code: 'type.already-active' });
}

export const PROPOSAL_STATES = [
  'pending',
  'approved',
  'rejected',
  'withdrawn',
  'superseded',
] as const;
export type ProposalState = (typeof PROPOSAL_STATES)[number];

export type ProposalSubject = (typeof RELAXATION_SUBJECTS)[number];

/** What the closing rules read of a stored proposal. */
export interface ProposalRecord {
  readonly state: ProposalState;
  readonly proposerAccountId: string;
}

export type ProposalAction = 'approve' | 'reject' | 'withdraw';

export type ProposalProblem =
  | { readonly code: 'review.proposal-closed' }
  | { readonly code: 'review.second-admin-required' }
  | { readonly code: 'review.proposer-cannot-reject' }
  | { readonly code: 'review.not-proposer' };

/**
 * Closes a pending proposal (design 7.6): `approve` by a second admin who is not the proposer
 * (H1, the rule of Q3 and AC 20; the denial is `review.second-admin-required`), `reject` by an
 * admin who is not the proposer, `withdraw` by the proposer only. A decided proposal is frozen
 * (the database trigger says the same).
 */
export function closeProposal(
  proposal: ProposalRecord,
  action: ProposalAction,
  actorAccountId: string,
): Result<'approved' | 'rejected' | 'withdrawn', ProposalProblem> {
  if (proposal.state !== 'pending') return err({ code: 'review.proposal-closed' });
  const second = assertSecondAdmin(proposal.proposerAccountId, actorAccountId);
  switch (action) {
    case 'approve':
      return second.ok ? ok('approved') : err({ code: 'review.second-admin-required' });
    case 'reject':
      return second.ok ? ok('rejected') : err({ code: 'review.proposer-cannot-reject' });
    case 'withdraw':
      return second.ok ? err({ code: 'review.not-proposer' }) : ok('withdrawn');
  }
}

/**
 * `inactive` → `active` when a second admin approves the pending `type-reactivation` proposal
 * (design 3.6; H1).
 */
export function reactivateType(
  status: TypeStatus,
  proposal: ProposalRecord,
  approverAccountId: string,
): Result<TypeStatus, TypeStatusProblem | ProposalProblem> {
  if (status !== 'inactive') return err({ code: 'type.already-active' });
  const closed = closeProposal(proposal, 'approve', approverAccountId);
  return closed.ok ? ok('active') : closed;
}
