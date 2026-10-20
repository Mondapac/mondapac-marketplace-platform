import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';

/** Who a conversation belongs to: a customer account, or a guest token (by its hash only). */
export type ConversationOwner =
  | { readonly kind: 'account'; readonly accountId: Id<'Account'> }
  | { readonly kind: 'guest'; readonly tokenHash: string };

export interface ConversationRecord {
  readonly id: string;
  readonly owner: ConversationOwner;
  /** Buyer messages so far. */
  readonly turns: number;
  /** 0: no message text is kept for this conversation. */
  readonly retentionDays: number;
}

/** One stored message, decrypted; the buyer's text was masked before it was stored. */
export interface StoredMessage {
  readonly role: 'buyer' | 'assistant';
  readonly text: string;
}

/**
 * `assistant.conversations` and `assistant.messages`. The message text is encrypted under the
 * conversation's own subject key (ADR-0019 R5, ADR-0009 decision 6), so a purge destroys the key
 * and a copy of a row reads as nothing. Every method runs in the caller's unit of work.
 */
export interface ConversationRepository {
  find(market: MarketContext, id: string): Promise<ConversationRecord | null>;
  /** Creates the conversation (and its key when text is kept); false if the id is taken. */
  create(
    market: MarketContext,
    conversation: ConversationRecord & { readonly startedAt: Temporal.Instant },
  ): Promise<boolean>;
  /** The last `limit` messages, oldest first. */
  history(market: MarketContext, id: string, limit: number): Promise<readonly StoredMessage[]>;
  /** Counts a buyer turn; false when another request took the last turn first. */
  countTurn(
    market: MarketContext,
    id: string,
    expectedTurns: number,
    at: Temporal.Instant,
  ): Promise<boolean>;
  append(
    market: MarketContext,
    id: string,
    message: StoredMessage & { readonly cards: readonly string[]; readonly at: Temporal.Instant },
  ): Promise<void>;
  /**
   * Deletes up to `limit` conversations whose last message is older than their retention, with
   * their messages, and destroys their keys. The retention is the shorter of the one stored with
   * the conversation and the current setting (`currentDays`, by owner kind), and at least one day
   * (a conversation that keeps no text keeps its turn count for a day). Answers how many.
   */
  purgeExpired(
    market: MarketContext,
    now: Temporal.Instant,
    currentDays: { readonly customer: number; readonly guest: number },
    limit: number,
  ): Promise<number>;
}

export const CONVERSATION_REPOSITORY = Symbol('CONVERSATION_REPOSITORY');
