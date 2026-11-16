import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { DEFAULT_ASSISTANT_SETTINGS } from '../domain/assistant-settings';
import {
  conversationTitle,
  HISTORY_PAGE_DEFAULT,
  HISTORY_PAGE_MAX,
  MAX_TURNS,
  parseConversationId,
  retentionDaysOf,
  retentionInForce,
  storedCardOf,
  type FieldError,
  type StoredCard,
} from '../domain/conversation';
import type { AssistantDependencies } from './assistant-dependencies';
import type { ConversationCursor } from './ports/conversation.repository';

// A signed-in buyer's own conversations (stage 0, B2): the list within the retention in force,
// one conversation's transcript, and deleting one. The account always comes from the session;
// a conversation of anyone else answers as not found.

/** The stored retentions that keep text (the table's CHECK allows 0, 30 and 365). */
const TEXT_RETENTIONS = [30, 365] as const;

export type HistoryFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'validation.failed'; readonly fields: readonly FieldError[] }
  /** The assistant is off for this Market (R8). */
  | { readonly code: 'assistant.off' }
  | { readonly code: 'assistant.conversation-not-found' };

export interface ConversationListItem {
  readonly id: string;
  readonly title: string;
  readonly turns: number;
  /** 30 buyer messages: the widget starts a new conversation instead of continuing this one. */
  readonly full: boolean;
  readonly startedAt: Temporal.Instant;
  readonly lastMessageAt: Temporal.Instant;
}

export interface ConversationPage {
  readonly items: readonly ConversationListItem[];
  /** Opaque; pass as `cursor` for the next page. null on the last page. */
  readonly nextCursor: string | null;
}

export interface ConversationTranscript extends ConversationListItem {
  readonly messages: readonly {
    readonly position: number;
    readonly role: 'buyer' | 'assistant';
    readonly text: string;
    /** Kinds and ids only: a product card's price and text are read again, never replayed. */
    readonly cards: readonly StoredCard[];
    readonly at: Temporal.Instant;
  }[];
}

export interface DeletedConversation {
  readonly deleted: true;
}

const DAY_HOURS = 24;

/** The page cursor: the last row's time and id, base64url, so the client treats it as opaque. */
export const encodeCursor = (cursor: ConversationCursor): string =>
  Buffer.from(`${cursor.lastMessageAt.epochMilliseconds}.${cursor.id}`, 'utf8').toString(
    'base64url',
  );

export function decodeCursor(value: unknown): Result<ConversationCursor | null, FieldError> {
  if (value === undefined || value === null) return ok(null);
  const bad = err({ path: 'cursor', code: 'format' } as const);
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,96}$/.test(value)) return bad;
  const [ms, id, ...rest] = Buffer.from(value, 'base64url').toString('utf8').split('.');
  if (rest.length > 0 || ms === undefined || id === undefined || !/^\d{1,15}$/.test(ms)) {
    return bad;
  }
  if (!parseId(id).ok) return bad;
  return ok({ lastMessageAt: Temporal.Instant.fromEpochMilliseconds(Number(ms)), id });
}

function parseLimit(value: unknown): Result<number, FieldError> {
  if (value === undefined || value === null) return ok(HISTORY_PAGE_DEFAULT);
  const number = typeof value === 'string' && /^\d{1,3}$/.test(value) ? Number(value) : value;
  return typeof number === 'number' &&
    Number.isInteger(number) &&
    number >= 1 &&
    number <= HISTORY_PAGE_MAX
    ? ok(number)
    : err({ path: 'limit', code: 'range' });
}

/** The current customer retention of the Market, in days, and whether the assistant is on. */
async function currentCustomerDays(
  deps: AssistantDependencies,
  context: CallContext,
): Promise<{ enabled: boolean; days: number }> {
  const settings = (await deps.settings.latest(context.market))?.settings;
  const current = settings ?? DEFAULT_ASSISTANT_SETTINGS;
  return { enabled: current.enabled, days: retentionDaysOf(current.retention, 'customer') };
}

const listItemOf = (row: {
  id: string;
  turns: number;
  startedAt: Temporal.Instant;
  lastMessageAt: Temporal.Instant;
  firstBuyerText: string | null;
}): ConversationListItem => ({
  id: row.id,
  title: conversationTitle(row.firstBuyerText),
  turns: row.turns,
  full: row.turns >= MAX_TURNS,
  startedAt: row.startedAt,
  lastMessageAt: row.lastMessageAt,
});

/** The buyer's own conversations that keep text and are within the retention in force. */
export async function listConversations(
  deps: AssistantDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: { readonly cursor?: unknown; readonly limit?: unknown },
): Promise<Result<ConversationPage, HistoryFailure>> {
  const cursor = decodeCursor(input?.cursor);
  const limit = parseLimit(input?.limit);
  if (!cursor.ok || !limit.ok) {
    const fields = [cursor, limit].flatMap((parsed) => (parsed.ok ? [] : [parsed.error]));
    return err({ code: 'validation.failed', fields });
  }
  const { market } = context;
  const now = deps.clock.now();
  return deps.unitOfWork.run<ConversationPage, HistoryFailure>(
    market,
    async () => {
      const current = await currentCustomerDays(deps, context);
      if (!current.enabled) return err({ code: 'assistant.off' });
      const visibleSince = new Map<number, Temporal.Instant>();
      for (const stored of TEXT_RETENTIONS) {
        const days = retentionInForce(stored, current.days);
        if (days > 0) visibleSince.set(stored, now.subtract({ hours: days * DAY_HOURS }));
      }
      const page = await deps.conversations.listByAccount(market, accountId, {
        visibleSince,
        after: cursor.value,
        limit: limit.value,
      });
      return ok({
        // A conversation with no stored buyer message opens as not found: not listed either.
        items: page.rows.filter((row) => row.firstBuyerText !== null).map(listItemOf),
        nextCursor: page.next === null ? null : encodeCursor(page.next),
      });
    },
    { readOnly: true },
  );
}

/** One of the buyer's own conversations, every stored message decrypted, oldest first. */
export async function viewConversation(
  deps: AssistantDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: { readonly conversationId: unknown },
): Promise<Result<ConversationTranscript, HistoryFailure>> {
  const id = parseConversationId(input?.conversationId);
  if (!id.ok) return err({ code: 'validation.failed', fields: [id.error] });
  const { market } = context;
  const now = deps.clock.now();
  const notFound = err({ code: 'assistant.conversation-not-found' } as const);
  return deps.unitOfWork.run<ConversationTranscript, HistoryFailure>(
    market,
    async () => {
      const current = await currentCustomerDays(deps, context);
      if (!current.enabled) return err({ code: 'assistant.off' });
      const found = await deps.conversations.find(market, id.value);
      if (found === null || found.owner.kind !== 'account' || found.owner.accountId !== accountId) {
        return notFound;
      }
      const days = retentionInForce(found.retentionDays, current.days);
      const since = now.subtract({ hours: days * DAY_HOURS });
      if (days <= 0 || Temporal.Instant.compare(found.lastMessageAt, since) < 0) return notFound;
      const stored = await deps.conversations.transcript(market, id.value);
      // A destroyed key: the conversation is being deleted or purged.
      if (stored.length === 0) return notFound;
      const first = stored.find((message) => message.role === 'buyer');
      return ok({
        ...listItemOf({ ...found, firstBuyerText: first?.text ?? null }),
        messages: stored.map((message) => ({
          position: message.position,
          role: message.role,
          text: message.text,
          cards: message.cards.flatMap((ref) => {
            const card = storedCardOf(ref);
            return card === null ? [] : [card];
          }),
          at: message.at,
        })),
      });
    },
    { readOnly: true },
  );
}

/**
 * Deletes one of the buyer's own conversations with its messages and destroys its key. Allowed
 * while the assistant is off too: a buyer can always erase their own conversation.
 */
export async function deleteConversation(
  deps: AssistantDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  input: { readonly conversationId: unknown },
): Promise<Result<DeletedConversation, HistoryFailure>> {
  const id = parseConversationId(input?.conversationId);
  if (!id.ok) return err({ code: 'validation.failed', fields: [id.error] });
  const { market } = context;
  return deps.unitOfWork.run<DeletedConversation, HistoryFailure>(market, async () =>
    (await deps.conversations.deleteOwn(market, id.value, accountId))
      ? ok({ deleted: true } as const)
      : err({ code: 'assistant.conversation-not-found' }),
  );
}
