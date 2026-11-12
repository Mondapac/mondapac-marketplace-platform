import { err, ok, parsePlainText } from '@mondapac/shared-kernel';
import type { Id, MarketId, Result, Temporal } from '@mondapac/shared-kernel';
import { noticeRetryAt } from './certificate-expiry-notice';
import { TOPIC_TERM_MAX, TOPIC_TERM_MIN, normaliseTopicTerm } from './topic';

// A seller's suggestion of a new tag (product tags package T5; john's decision 1, 24 Oct 2026).
// Born `open`, it moves once: an admin approves it (a topic was created from it), maps it to an
// existing topic, or rejects it with a reason. Then one mail tells the seller; the notice has its
// own small state so a failed send is tried again without touching the decision.
//
//   open --approve--> approved        notice: none --decide--> pending --> sent | skipped | failed
//        --map------> mapped
//        --reject---> rejected

export const SUGGESTION_LABEL_MAX = TOPIC_TERM_MAX;
export const SUGGESTION_LABEL_MIN = TOPIC_TERM_MIN;
export const SUGGESTION_REASON_MAX = 300;
/** How many suggestions of one seller may wait for a decision at once. */
export const MAX_OPEN_SUGGESTIONS_PER_SELLER = 10;

export type SuggestionStatus = 'open' | 'approved' | 'mapped' | 'rejected';
export type SuggestionNoticeState = 'none' | 'pending' | 'sent' | 'skipped' | 'failed';

export interface TopicSuggestionState {
  readonly id: Id<'TopicSuggestion'>;
  readonly marketId: MarketId;
  readonly sellerId: Id<'Seller'>;
  readonly productId: Id<'Product'>;
  /** The seller's own text, in the Market's default locale. Admins see it; buyers never do. */
  readonly label: string;
  /** The label's normalised form ({@link normaliseTopicTerm}): the key a repeat is found on. */
  readonly labelKey: string;
  readonly status: SuggestionStatus;
  /** The topic created (approved) or chosen (mapped). */
  readonly topicId: Id<'Topic'> | null;
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
  | { readonly code: 'suggestion.topic-invalid' }
  /** The suggestion was decided before. */
  | { readonly code: 'suggestion.not-open' };

/** A plain text of 1 to `max` characters with no edge space (the database repeats it). */
export function isSuggestionText(text: string, max: number, min = 1): boolean {
  const length = [...text].length;
  return (
    text === text.trim() &&
    length >= min &&
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

export class TopicSuggestion {
  readonly #state: TopicSuggestionState;

  private constructor(state: TopicSuggestionState) {
    this.#state = state;
  }

  get state(): TopicSuggestionState {
    return this.#state;
  }

  /** A new open suggestion. The label is tidied, then checked. */
  static open(input: {
    readonly id: Id<'TopicSuggestion'>;
    readonly marketId: MarketId;
    readonly sellerId: Id<'Seller'>;
    readonly productId: Id<'Product'>;
    readonly label: string;
    readonly now: Temporal.Instant;
  }): Result<TopicSuggestion, SuggestionRefusal> {
    const label = tidySuggestionText(input.label);
    if (!isSuggestionText(label, SUGGESTION_LABEL_MAX, SUGGESTION_LABEL_MIN)) {
      return err({ code: 'suggestion.label-invalid' });
    }
    const labelKey = normaliseTopicTerm(label);
    if (labelKey.length < TOPIC_TERM_MIN) return err({ code: 'suggestion.label-invalid' });
    return ok(
      new TopicSuggestion({
        id: input.id,
        marketId: input.marketId,
        sellerId: input.sellerId,
        productId: input.productId,
        label,
        labelKey,
        status: 'open',
        topicId: null,
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

  static rehydrate(state: TopicSuggestionState): TopicSuggestion {
    return new TopicSuggestion(state);
  }

  /** Approved: the admin created the topic `topicId` from it. */
  approve(input: {
    readonly accountId: Id<'Account'>;
    readonly topicId: Id<'Topic'>;
    readonly now: Temporal.Instant;
  }): Result<TopicSuggestion, SuggestionRefusal> {
    return this.#decide('approved', input.accountId, input.topicId, null, input.now);
  }

  /** Mapped: the admin chose the existing topic `topicId` for it. */
  map(input: {
    readonly accountId: Id<'Account'>;
    readonly topicId: Id<'Topic'>;
    readonly now: Temporal.Instant;
  }): Result<TopicSuggestion, SuggestionRefusal> {
    return this.#decide('mapped', input.accountId, input.topicId, null, input.now);
  }

  /** Rejected, with the words the seller will read. */
  reject(input: {
    readonly accountId: Id<'Account'>;
    readonly reason: string;
    readonly now: Temporal.Instant;
  }): Result<TopicSuggestion, SuggestionRefusal> {
    const reason = tidySuggestionText(input.reason);
    if (!isSuggestionText(reason, SUGGESTION_REASON_MAX)) {
      return err({ code: 'suggestion.reason-invalid' });
    }
    return this.#decide('rejected', input.accountId, null, reason, input.now);
  }

  #decide(
    status: 'approved' | 'mapped' | 'rejected',
    accountId: Id<'Account'>,
    topicId: Id<'Topic'> | null,
    rejectReason: string | null,
    now: Temporal.Instant,
  ): Result<TopicSuggestion, SuggestionRefusal> {
    const current = this.#state;
    if (current.status !== 'open') return err({ code: 'suggestion.not-open' });
    if (status !== 'rejected' && topicId === null) return err({ code: 'suggestion.topic-invalid' });
    return ok(
      new TopicSuggestion({
        ...current,
        status,
        topicId,
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
  noticeSent(): TopicSuggestion | null {
    return this.#settled('sent', this.#state.noticeAttempts + 1);
  }

  /** The notice has nobody to go to (no usable address): settled without a mail. */
  noticeSkipped(): TopicSuggestion | null {
    return this.#settled('skipped', this.#state.noticeAttempts);
  }

  /**
   * A send failed: tried again later, or given up as `failed` once the attempts are used up
   * ({@link noticeRetryAt}).
   */
  noticeFailedAt(now: Temporal.Instant): TopicSuggestion | null {
    const current = this.#state;
    if (current.noticeState !== 'pending') return null;
    const retry = noticeRetryAt(current.noticeAttempts, now);
    const attempts = current.noticeAttempts + 1;
    if (retry === null) return this.#settled('failed', attempts);
    return new TopicSuggestion({
      ...current,
      noticeAttempts: attempts,
      noticeNextAttemptAt: retry,
      version: current.version + 1,
    });
  }

  #settled(state: 'sent' | 'skipped' | 'failed', attempts: number): TopicSuggestion | null {
    const current = this.#state;
    if (current.noticeState !== 'pending') return null;
    return new TopicSuggestion({
      ...current,
      noticeState: state,
      noticeAttempts: attempts,
      noticeNextAttemptAt: null,
      version: current.version + 1,
    });
  }
}
