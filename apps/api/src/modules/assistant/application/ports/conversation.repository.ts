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

/** A conversation as found, with its times. */
export interface FoundConversation extends ConversationRecord {
  readonly startedAt: Temporal.Instant;
  readonly lastMessageAt: Temporal.Instant;
}

/** One row of a buyer's list of conversations, newest activity first. */
export interface ConversationSummary {
  readonly id: string;
  readonly turns: number;
  readonly startedAt: Temporal.Instant;
  readonly lastMessageAt: Temporal.Instant;
  /** The first buyer message, decrypted (masked when stored); null when none is readable. */
  readonly firstBuyerText: string | null;
}

/** Where a page of the list starts: after this conversation (keyset, newest first). */
export interface ConversationCursor {
  readonly lastMessageAt: Temporal.Instant;
  readonly id: string;
}

/** A page of the list as stored. */
export interface ConversationListPage {
  readonly rows: readonly ConversationSummary[];
  readonly next: ConversationCursor | null;
}

/** One stored message of a transcript, decrypted, with its card refs and time. */
export interface TranscriptMessage {
  readonly position: number;
  readonly role: 'buyer' | 'assistant';
  readonly text: string;
  readonly cards: readonly string[];
  readonly at: Temporal.Instant;
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
  find(market: MarketContext, id: string): Promise<FoundConversation | null>;
  /**
   * Whether this id belonged to a conversation that is gone (deleted or purged with its key):
   * such an id can never start a new conversation that keeps text.
   */
  spent(market: MarketContext, id: string): Promise<boolean>;
  /**
   * Creates the conversation (and its key when text is kept); false if the id is taken, or is
   * spent and the new one would keep text.
   */
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
   * The start and last-message instants of one account's conversations of the Market, by start
   * then id in the direction given (customers management phase 2b). Never a message.
   */
  datesOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ): Promise<
    readonly { readonly startedAt: Temporal.Instant; readonly lastMessageAt: Temporal.Instant }[]
  >;
  /** How many conversations one account of the Market has. */
  countOfAccount(market: MarketContext, accountId: Id<'Account'>): Promise<number>;
  /**
   * One page of an account's conversations that keep text, newest activity first, after `after`:
   * a conversation that stored `retentionDays` is listed only when its last message is at or
   * after `visibleSince[retentionDays]` (a stored retention missing from the map is not listed).
   * A conversation whose key was destroyed is left out of `rows` but still moves the page on:
   * `next` is where the following page starts, null on the last page.
   */
  listByAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    query: {
      readonly visibleSince: ReadonlyMap<number, Temporal.Instant>;
      readonly after: ConversationCursor | null;
      readonly limit: number;
    },
  ): Promise<ConversationListPage>;
  /** Every stored message of a conversation, oldest first; empty when its key was destroyed. */
  transcript(market: MarketContext, id: string): Promise<readonly TranscriptMessage[]>;
  /**
   * Deletes one account's conversation with its messages and destroys its key (when it had
   * one). False when no such conversation of that account exists.
   */
  deleteOwn(market: MarketContext, id: string, accountId: Id<'Account'>): Promise<boolean>;
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
