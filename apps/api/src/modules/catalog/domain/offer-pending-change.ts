import { err, ok } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import { OFFER_HANDLINGS, type OfferHandling } from './offer-handling';
import { OFFER_REVIEW_REASONS, type OfferReviewReason } from './offer-review-policy';
import { isTagTypeCode } from './offer-tag';

/** The statuses of a held edit; `pending` is the only open one (data design, slice 2c). */
export const OFFER_PENDING_CHANGE_STATUSES = [
  'pending',
  'approved',
  'changes-requested',
  'rejected',
  'withdrawn',
  'superseded',
] as const;
export type OfferPendingChangeStatus = (typeof OFFER_PENDING_CHANGE_STATUSES)[number];

/** Why a change was set aside without a decision: a new edit replaced it, or the Offer went. */
export const OFFER_CHANGE_SUPERSEDED_CAUSES = ['resubmitted', 'offer-deleted'] as const;
export type OfferChangeSupersededCause = (typeof OFFER_CHANGE_SUPERSEDED_CAUSES)[number];

/** The watched fields a held change can carry, in a fixed order. */
export const OFFER_CHANGE_FIELDS = ['description', 'handling', 'tags'] as const;
export type OfferChangeField = (typeof OFFER_CHANGE_FIELDS)[number];

/** The longest decision note (`offer_pending_changes_decision_note_check`). */
export const MAX_DECISION_NOTE_CHARS = 2000;
/** The most type codes one change may request (`offer_pending_changes_proposed_tag_types_check`). */
export const MAX_PROPOSED_TAG_TYPES = 32;

export interface OfferPendingChangeState {
  readonly id: Id<'OfferPendingChange'>;
  readonly marketId: MarketId;
  readonly offerId: Id<'Offer'>;
  readonly sellerId: Id<'Seller'>;
  /** The Offer version the change was made against (audit only). */
  readonly baseOfferVersion: number;
  /** The whole new description, or null when the change leaves it. Never logged. */
  readonly proposedDescription: Readonly<Record<string, string>> | null;
  readonly proposedHandling: OfferHandling | null;
  /** Requested certification type codes; never tag rows (the approval asks again). */
  readonly proposedTagTypes: readonly string[];
  /** Never empty: a change with no reason is applied at once, never held. */
  readonly reasons: readonly OfferReviewReason[];
  readonly policyVersion: number;
  readonly status: OfferPendingChangeStatus;
  readonly supersededCause: OfferChangeSupersededCause | null;
  readonly submittedAt: Temporal.Instant;
  readonly submittedByAccountId: Id<'Account'>;
  readonly decidedAt: Temporal.Instant | null;
  /** The admin who decided, or the seller account that withdrew; null when pending or superseded. */
  readonly decidedByAccountId: Id<'Account'> | null;
  /** The reviewer's note to the seller. Free text: never logged, never sent to a model. */
  readonly decisionNote: string | null;
}

/** Why a command on a held change was refused: a stable code, never data. */
export type OfferPendingChangeRefusal =
  | { readonly code: 'offer-change.not-pending' }
  | { readonly code: 'offer-change.note-invalid' }
  | { readonly code: 'offer-change.invalid' }
  | { readonly code: 'offer-change.own-submission' };

function validNote(note: unknown): note is string {
  return (
    typeof note === 'string' && note.trim().length > 0 && note.length <= MAX_DECISION_NOTE_CHARS
  );
}

/**
 * An edit of a live Offer that the review policy held (risk-based Offer approval, slice 2c;
 * ADR-0051). Born `pending` with the watched fields of one request (description, handling,
 * requested badge types) and the policy's reasons; decided once: an admin approves, requests
 * changes or rejects (a note is required for the last two; never the admin who submitted it), the seller withdraws, or the system
 * supersedes it (a new edit replaced it, or the Offer was deleted). The live Offer is never
 * changed here: the approval use case applies the held fields to the Offer in the same unit.
 */
export class OfferPendingChange {
  #state: OfferPendingChangeState;
  readonly #isNew: boolean;
  #decided = false;

  private constructor(state: OfferPendingChangeState, isNew: boolean) {
    this.#state = Object.freeze(state);
    this.#isNew = isNew;
  }

  /** A new held change. Refuses an empty change, an empty reason list or a malformed field. */
  static propose(input: {
    readonly id: Id<'OfferPendingChange'>;
    readonly marketId: MarketId;
    readonly offerId: Id<'Offer'>;
    readonly sellerId: Id<'Seller'>;
    readonly baseOfferVersion: number;
    readonly proposedDescription?: Readonly<Record<string, string>> | null;
    readonly proposedHandling?: OfferHandling | null;
    readonly proposedTagTypes?: readonly string[];
    readonly reasons: readonly OfferReviewReason[];
    readonly policyVersion: number;
    readonly submittedByAccountId: Id<'Account'>;
    readonly now: Temporal.Instant;
  }): Result<OfferPendingChange, OfferPendingChangeRefusal> {
    const description = input.proposedDescription ?? null;
    const handling = input.proposedHandling ?? null;
    const tags = [...(input.proposedTagTypes ?? [])];
    const invalid = err({ code: 'offer-change.invalid' } as const);
    if (description === null && handling === null && tags.length === 0) return invalid;
    if (
      description !== null &&
      (typeof description !== 'object' ||
        Array.isArray(description) ||
        Object.values(description).some((text) => typeof text !== 'string'))
    ) {
      return invalid;
    }
    if (handling !== null && !(OFFER_HANDLINGS as readonly string[]).includes(handling)) {
      return invalid;
    }
    if (
      tags.length > MAX_PROPOSED_TAG_TYPES ||
      new Set(tags).size !== tags.length ||
      !tags.every(isTagTypeCode)
    ) {
      return invalid;
    }
    if (
      input.reasons.length === 0 ||
      new Set(input.reasons).size !== input.reasons.length ||
      !input.reasons.every((reason) => OFFER_REVIEW_REASONS.includes(reason))
    ) {
      return invalid;
    }
    if (!Number.isInteger(input.baseOfferVersion) || input.baseOfferVersion < 1) return invalid;
    return ok(
      new OfferPendingChange(
        {
          id: input.id,
          marketId: input.marketId,
          offerId: input.offerId,
          sellerId: input.sellerId,
          baseOfferVersion: input.baseOfferVersion,
          proposedDescription: description === null ? null : Object.freeze({ ...description }),
          proposedHandling: handling,
          proposedTagTypes: Object.freeze(tags),
          reasons: Object.freeze([...input.reasons]),
          policyVersion: input.policyVersion,
          status: 'pending',
          supersededCause: null,
          submittedAt: input.now,
          submittedByAccountId: input.submittedByAccountId,
          decidedAt: null,
          decidedByAccountId: null,
          decisionNote: null,
        },
        true,
      ),
    );
  }

  /** A change read back from storage. */
  static restore(state: OfferPendingChangeState): OfferPendingChange {
    return new OfferPendingChange(state, false);
  }

  /** An admin approves: the use case applies the held fields in the same unit. Note optional. */
  approve(input: {
    readonly accountId: Id<'Account'>;
    readonly note?: string | null;
    readonly now: Temporal.Instant;
  }): Result<void, OfferPendingChangeRefusal> {
    const note = input.note ?? null;
    if (note !== null && !validNote(note)) return err({ code: 'offer-change.note-invalid' });
    if (this.#ownSubmission(input.accountId)) return err({ code: 'offer-change.own-submission' });
    return this.#decide('approved', input.accountId, note, null, input.now);
  }

  /** An admin sends the change back with a note (required); the live Offer stays as it is. */
  requestChanges(input: {
    readonly accountId: Id<'Account'>;
    readonly note: string;
    readonly now: Temporal.Instant;
  }): Result<void, OfferPendingChangeRefusal> {
    if (!validNote(input.note)) return err({ code: 'offer-change.note-invalid' });
    if (this.#ownSubmission(input.accountId)) return err({ code: 'offer-change.own-submission' });
    return this.#decide('changes-requested', input.accountId, input.note, null, input.now);
  }

  /** An admin rejects the change with a note (required); terminal, the live Offer stays. */
  reject(input: {
    readonly accountId: Id<'Account'>;
    readonly note: string;
    readonly now: Temporal.Instant;
  }): Result<void, OfferPendingChangeRefusal> {
    if (!validNote(input.note)) return err({ code: 'offer-change.note-invalid' });
    if (this.#ownSubmission(input.accountId)) return err({ code: 'offer-change.own-submission' });
    return this.#decide('rejected', input.accountId, input.note, null, input.now);
  }

  /** The seller withdraws their own change; the live Offer stays as it is. */
  withdraw(input: {
    readonly accountId: Id<'Account'>;
    readonly now: Temporal.Instant;
  }): Result<void, OfferPendingChangeRefusal> {
    return this.#decide('withdrawn', input.accountId, null, null, input.now);
  }

  /** The system sets the change aside: a new edit replaced it, or the Offer was deleted. */
  supersede(input: {
    readonly cause: OfferChangeSupersededCause;
    readonly now: Temporal.Instant;
  }): Result<void, OfferPendingChangeRefusal> {
    if (!(OFFER_CHANGE_SUPERSEDED_CAUSES as readonly string[]).includes(input.cause)) {
      return err({ code: 'offer-change.invalid' });
    }
    return this.#decide('superseded', null, null, input.cause, input.now);
  }

  /**
   * An admin never decides a change their own account submitted (Hassan N3 on PR #1350): a
   * change made in a Login-as-Seller session carries the admin's account, as the real admin stays
   * the actor there. The seller's withdrawal is not a review decision and is not checked.
   */
  #ownSubmission(accountId: Id<'Account'>): boolean {
    return accountId === this.#state.submittedByAccountId;
  }

  #decide(
    status: Exclude<OfferPendingChangeStatus, 'pending'>,
    accountId: Id<'Account'> | null,
    note: string | null,
    cause: OfferChangeSupersededCause | null,
    now: Temporal.Instant,
  ): Result<void, OfferPendingChangeRefusal> {
    if (this.#state.status !== 'pending') return err({ code: 'offer-change.not-pending' });
    // A decision is never earlier than the submit (`offer_pending_changes_decided_at_check`).
    const decidedAt =
      compareInstants(now, this.#state.submittedAt) < 0 ? this.#state.submittedAt : now;
    this.#state = Object.freeze({
      ...this.#state,
      status,
      supersededCause: cause,
      decidedAt,
      decidedByAccountId: accountId,
      decisionNote: note,
    });
    this.#decided = true;
    return ok(undefined);
  }

  /** The watched fields this change carries, in {@link OFFER_CHANGE_FIELDS} order. */
  get fields(): readonly OfferChangeField[] {
    const state = this.#state;
    return OFFER_CHANGE_FIELDS.filter((field) =>
      field === 'description'
        ? state.proposedDescription !== null
        : field === 'handling'
          ? state.proposedHandling !== null
          : state.proposedTagTypes.length > 0,
    );
  }

  get state(): OfferPendingChangeState {
    return this.#state;
  }

  /** True for a change made by {@link propose} and not stored yet. */
  get isNew(): boolean {
    return this.#isNew;
  }

  /** True when a decision was made since the read (the repository stores it once). */
  get decided(): boolean {
    return this.#decided;
  }
}

function compareInstants(a: Temporal.Instant, b: Temporal.Instant): number {
  return a.epochNanoseconds < b.epochNanoseconds
    ? -1
    : a.epochNanoseconds > b.epochNanoseconds
      ? 1
      : 0;
}
