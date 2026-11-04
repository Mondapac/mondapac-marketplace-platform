import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import { noticeRetryAt } from './certificate-expiry-notice';

// A seller's suggestion of a new value for a select attribute (attributes plan, package A5; catalog
// data design 3.30). Born `open`, it moves once: an admin approves it (the value was added to the
// attribute), maps it to an existing value, or rejects it with a reason. Then one mail tells the
// seller; the notice has its own small state so a failed send is tried again without touching the
// decision.
//
//   open --approve--> approved        notice: none --decide--> pending --> sent | skipped | failed
//        --map------> mapped
//        --reject---> rejected

export const SUGGESTION_LABEL_MAX = 120;
export const SUGGESTION_REASON_MAX = 300;
/** How many suggestions of one seller may wait for a decision at once. */
export const MAX_OPEN_SUGGESTIONS_PER_SELLER = 10;

const OPTION_CODE = /^[a-z][a-z0-9_-]{0,63}$/;

export type SuggestionStatus = 'open' | 'approved' | 'mapped' | 'rejected';
export type SuggestionNoticeState = 'none' | 'pending' | 'sent' | 'skipped' | 'failed';

export interface AttributeValueSuggestionState {
  readonly id: Id<'AttributeValueSuggestion'>;
  readonly marketId: MarketId;
  readonly definitionId: Id<'AttributeDefinition'>;
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  /** The seller's own text, in the Market's default locale. Admins see it; buyers never do. */
  readonly label: string;
  readonly status: SuggestionStatus;
  /** The value added (approved) or chosen (mapped). */
  readonly optionCode: string | null;
  /** The reviewer's words to the seller (rejected). */
  readonly rejectReason: string | null;
  readonly decidedByAccountId: Id<'Account'> | null;
  readonly decidedAt: Temporal.Instant | null;
  readonly noticeState: SuggestionNoticeState;
  readonly noticeAttempts: number;
  readonly noticeNextAttemptAt: Temporal.Instant | null;
  readonly version: number;
  readonly createdAt: Temporal.Instant;
}

export type SuggestionRefusal =
  | { readonly code: 'suggestion.label-invalid' }
  | { readonly code: 'suggestion.reason-invalid' }
  | { readonly code: 'suggestion.option-invalid' }
  /** The suggestion was decided before. */
  | { readonly code: 'suggestion.not-open' };

/** A plain text of 1 to `max` characters with no edge space (the database repeats it). */
export function isSuggestionText(text: string, max: number): boolean {
  const length = [...text].length;
  return (
    text === text.trim() &&
    length >= 1 &&
    length <= max &&
    ![...text].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 0x20 || point === 0x7f;
    }) &&
    parsePlainText(text).ok
  );
}

/** What a seller typed, as it is stored: inner runs of space become one, the ends are trimmed. */
export const tidySuggestionText = (raw: string): string => raw.replace(/\s+/gu, ' ').trim();

export class AttributeValueSuggestion {
  readonly #state: AttributeValueSuggestionState;

  private constructor(state: AttributeValueSuggestionState) {
    this.#state = state;
  }

  get state(): AttributeValueSuggestionState {
    return this.#state;
  }

  /** A new open suggestion. The label is tidied, then checked. */
  static open(input: {
    readonly id: Id<'AttributeValueSuggestion'>;
    readonly marketId: MarketId;
    readonly definitionId: Id<'AttributeDefinition'>;
    readonly sellerId: Id<'Seller'>;
    readonly productId: Id<'Product'>;
    readonly label: string;
    readonly now: Temporal.Instant;
  }): Result<AttributeValueSuggestion, SuggestionRefusal> {
    const label = tidySuggestionText(input.label);
    if (!isSuggestionText(label, SUGGESTION_LABEL_MAX)) {
      return err({ code: 'suggestion.label-invalid' });
    }
    return ok(
      new AttributeValueSuggestion({
        id: input.id,
        marketId: input.marketId,
        definitionId: input.definitionId,
        sellerId: input.sellerId,
        productId: input.productId,
        label,
        status: 'open',
        optionCode: null,
        rejectReason: null,
        decidedByAccountId: null,
        decidedAt: null,
        noticeState: 'none',
        noticeAttempts: 0,
        noticeNextAttemptAt: null,
        version: 1,
        createdAt: input.now,
      }),
    );
  }

  static rehydrate(state: AttributeValueSuggestionState): AttributeValueSuggestion {
    return new AttributeValueSuggestion(state);
  }

  /** Approved: the admin added the value `optionCode` to the attribute. */
  approve(input: {
    readonly accountId: Id<'Account'>;
    readonly optionCode: string;
    readonly now: Temporal.Instant;
  }): Result<AttributeValueSuggestion, SuggestionRefusal> {
    return this.#decide('approved', input.accountId, input.optionCode, null, input.now);
  }

  /** Mapped: the admin chose the existing value `optionCode` for it. */
  map(input: {
    readonly accountId: Id<'Account'>;
    readonly optionCode: string;
    readonly now: Temporal.Instant;
  }): Result<AttributeValueSuggestion, SuggestionRefusal> {
    return this.#decide('mapped', input.accountId, input.optionCode, null, input.now);
  }

  /** Rejected, with the words the seller will read. */
  reject(input: {
    readonly accountId: Id<'Account'>;
    readonly reason: string;
    readonly now: Temporal.Instant;
  }): Result<AttributeValueSuggestion, SuggestionRefusal> {
    const reason = tidySuggestionText(input.reason);
    if (!isSuggestionText(reason, SUGGESTION_REASON_MAX)) {
      return err({ code: 'suggestion.reason-invalid' });
    }
    return this.#decide('rejected', input.accountId, null, reason, input.now);
  }

  #decide(
    status: 'approved' | 'mapped' | 'rejected',
    accountId: Id<'Account'>,
    optionCode: string | null,
    rejectReason: string | null,
    now: Temporal.Instant,
  ): Result<AttributeValueSuggestion, SuggestionRefusal> {
    const current = this.#state;
    if (current.status !== 'open') return err({ code: 'suggestion.not-open' });
    if (status !== 'rejected' && (optionCode === null || !OPTION_CODE.test(optionCode))) {
      return err({ code: 'suggestion.option-invalid' });
    }
    return ok(
      new AttributeValueSuggestion({
        ...current,
        status,
        optionCode,
        rejectReason,
        decidedByAccountId: accountId,
        decidedAt: now,
        noticeState: 'pending',
        noticeAttempts: 0,
        noticeNextAttemptAt: now,
        version: current.version + 1,
      }),
    );
  }

  /** The notice was sent. Only a pending notice moves. */
  noticeSent(): AttributeValueSuggestion | null {
    return this.#settled('sent', this.#state.noticeAttempts + 1);
  }

  /** The notice has nobody to go to (no usable address): settled without a mail. */
  noticeSkipped(): AttributeValueSuggestion | null {
    return this.#settled('skipped', this.#state.noticeAttempts);
  }

  /**
   * A send failed: tried again later, or given up as `failed` once the attempts are used up
   * ({@link noticeRetryAt}).
   */
  noticeFailedAt(now: Temporal.Instant): AttributeValueSuggestion | null {
    const current = this.#state;
    if (current.noticeState !== 'pending') return null;
    const retry = noticeRetryAt(current.noticeAttempts, now);
    const attempts = current.noticeAttempts + 1;
    if (retry === null) return this.#settled('failed', attempts);
    return new AttributeValueSuggestion({
      ...current,
      noticeAttempts: attempts,
      noticeNextAttemptAt: retry,
      version: current.version + 1,
    });
  }

  #settled(
    state: 'sent' | 'skipped' | 'failed',
    attempts: number,
  ): AttributeValueSuggestion | null {
    const current = this.#state;
    if (current.noticeState !== 'pending') return null;
    return new AttributeValueSuggestion({
      ...current,
      noticeState: state,
      noticeAttempts: attempts,
      noticeNextAttemptAt: null,
      version: current.version + 1,
    });
  }
}
