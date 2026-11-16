import { createHash } from 'node:crypto';
import { encodePayload, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext, MarketId, PendingEvent } from '@mondapac/shared-kernel';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { NO_PERMISSION_KEYS } from '../../../../platform/events/outbox-writer';
import { ASSISTANT_EVENTS } from '../../domain/events';
import type { ModelRequest, ModelTurn } from '../../../../platform/ai/model-provider';
import type { ModelTier } from '../../domain/assistant-settings';
import type { AssistantCard } from '../../domain/cards';
import type { ToolRequest } from '../../domain/tools';
import type { AssistantRuntime, ModelAnswer } from '../ports/assistant-runtime';
import type { AssistantTools, ToolOutcome } from '../ports/assistant-tools';
import type {
  ConversationCursor,
  ConversationListPage,
  ConversationRecord,
  ConversationRepository,
  ConversationSummary,
  StoredMessage,
  TranscriptMessage,
} from '../ports/conversation.repository';
import type { GuestTokens } from '../ports/guest-tokens';
import type { MarketCalendar } from '../ports/market-calendar';
import type { MessageLimits } from '../ports/message-limits';
import type { PreviewTokens } from '../ports/preview-tokens';
import type { QuickPrompts } from '../ports/quick-prompts';
import type { SpendRepository, SpendTotals } from '../ports/spend.repository';

// In-memory ports of the assistant for the use-case specs: the fake model answers from a script
// and records every request it was sent, so a spec can check what would reach a provider.

/** A model that answers from a script; an exhausted script answers a plain text. */
export class FakeRuntime implements AssistantRuntime {
  key = true;
  models: Record<ModelTier, string | null> = { fast: 'model-fast', balanced: null };
  priced = true;
  readonly requests: ModelRequest[] = [];
  readonly script: (ModelAnswer | ((request: ModelRequest) => ModelAnswer))[] = [];

  apiKeyConfigured() {
    return this.key;
  }
  modelOf(_marketId: MarketId, tier: ModelTier) {
    return this.models[tier];
  }
  configured(marketId: MarketId, tier: ModelTier) {
    return this.key && this.priced && this.modelOf(marketId, tier) !== null;
  }
  complete(_marketId: MarketId, _tier: ModelTier, request: ModelRequest): Promise<ModelAnswer> {
    this.requests.push(structuredClone(request));
    const next = this.script.shift();
    if (next === undefined) return Promise.resolve(answer({ text: 'How can I help?' }));
    return Promise.resolve(typeof next === 'function' ? next(request) : next);
  }
}

/** A model answer: text, tool calls, a stop reason and a cost. */
export function answer(turn: {
  text?: string;
  calls?: { id: string; name: string; input: unknown }[];
  stop?: ModelTurn['stop'];
  costMicroUsd?: number;
}): ModelAnswer {
  const blocks: ModelTurn['blocks'][number][] = [];
  if (turn.text !== undefined) blocks.push({ type: 'text', text: turn.text });
  for (const call of turn.calls ?? []) blocks.push({ type: 'tool-call', ...call });
  return {
    ok: true,
    costMicroUsd: turn.costMicroUsd ?? 100,
    turn: {
      blocks,
      stop: turn.stop ?? (turn.calls?.length ? 'tool-use' : 'end'),
      usage: { inputTokens: 1000, outputTokens: 100 },
    },
  };
}

/** The tools, answering fixed outcomes and recording each request with its caller's context. */
export class FakeTools implements AssistantTools {
  readonly runs: { context: CallContext; request: ToolRequest }[] = [];
  failing = false;
  products: AssistantCard[] = [];

  run(context: CallContext, request: ToolRequest): Promise<ToolOutcome> {
    this.runs.push({ context, request });
    if (this.failing) {
      return Promise.resolve({
        forModel: '{"error":"x"}',
        isError: true,
        cards: [],
        notices: ['tool-failed'],
      });
    }
    switch (request.tool) {
      case 'support_contact':
        return Promise.resolve({
          forModel: '{}',
          isError: false,
          cards: [{ kind: 'support', email: 'help@example.com' }],
          notices: [],
        });
      case 'search_products':
        return Promise.resolve({
          forModel: JSON.stringify({ products: this.products.map(() => ({ name: 'x' })) }),
          isError: false,
          cards: this.products,
          notices: [],
        });
      default:
        return Promise.resolve({ forModel: '{}', isError: false, cards: [], notices: [] });
    }
  }
}

/** Conversations and messages in memory; text is kept as is (encryption is the adapter's). */
export class MemoryConversations implements ConversationRepository {
  readonly rows = new Map<
    string,
    ConversationRecord & { market: string; startedAt: Temporal.Instant; lastAt: Temporal.Instant }
  >();
  readonly messages = new Map<string, (StoredMessage & { cards: readonly string[] })[]>();
  /** When each stored message was written, in the same order as `messages`. */
  readonly times = new Map<string, Temporal.Instant[]>();
  /** Conversations whose key was destroyed (their messages read as nothing). */
  readonly destroyed = new Set<string>();

  spent(_market: MarketContext, id: string) {
    return Promise.resolve(this.destroyed.has(id));
  }
  find(market: MarketContext, id: string) {
    const row = this.rows.get(id);
    return Promise.resolve(
      row === undefined || row.market !== market.marketId
        ? null
        : { ...row, lastMessageAt: row.lastAt },
    );
  }
  listByAccount(
    market: MarketContext,
    accountId: string,
    query: {
      visibleSince: ReadonlyMap<number, Temporal.Instant>;
      after: ConversationCursor | null;
      limit: number;
    },
  ): Promise<ConversationListPage> {
    const newestFirst = (a: { lastAt: Temporal.Instant; id: string }, b: typeof a) =>
      Temporal.Instant.compare(b.lastAt, a.lastAt) || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
    const { after } = query;
    const rows = [...this.rows.values()]
      .filter((row) => {
        if (row.market !== market.marketId) return false;
        if (row.owner.kind !== 'account' || row.owner.accountId !== accountId) return false;
        const since = query.visibleSince.get(row.retentionDays);
        if (row.retentionDays === 0 || since === undefined) return false;
        if (Temporal.Instant.compare(row.lastAt, since) < 0) return false;
        return (
          after === null || newestFirst({ lastAt: after.lastMessageAt, id: after.id }, row) < 0
        );
      })
      .sort(newestFirst);
    const page = rows.slice(0, Math.max(0, query.limit));
    const last = rows.length > page.length ? page.at(-1) : undefined;
    return Promise.resolve({
      next: last === undefined ? null : { lastMessageAt: last.lastAt, id: last.id },
      rows: page
        .filter((row) => !this.destroyed.has(row.id))
        .map((row): ConversationSummary => ({
          id: row.id,
          turns: row.turns,
          startedAt: row.startedAt,
          lastMessageAt: row.lastAt,
          firstBuyerText:
            (this.messages.get(row.id) ?? []).find((message) => message.role === 'buyer')?.text ??
            null,
        })),
    });
  }
  transcript(_market: MarketContext, id: string): Promise<readonly TranscriptMessage[]> {
    if (this.destroyed.has(id)) return Promise.resolve([]);
    const row = this.rows.get(id);
    return Promise.resolve(
      (this.messages.get(id) ?? []).map((message, index) => ({
        position: index + 1,
        role: message.role,
        text: message.text,
        cards: message.cards,
        at: this.timeOf(id, index, row?.lastAt),
      })),
    );
  }
  private timeOf(id: string, index: number, fallback: Temporal.Instant | undefined) {
    const at = this.times.get(id)?.[index] ?? fallback;
    if (at === undefined) throw new Error(`no time stored for message ${index} of ${id}`);
    return at;
  }
  deleteOwn(market: MarketContext, id: string, accountId: string) {
    const row = this.rows.get(id);
    if (
      row === undefined ||
      row.market !== market.marketId ||
      row.owner.kind !== 'account' ||
      row.owner.accountId !== accountId
    ) {
      return Promise.resolve(false);
    }
    this.rows.delete(id);
    this.messages.delete(id);
    this.times.delete(id);
    if (row.retentionDays > 0) this.destroyed.add(id);
    return Promise.resolve(true);
  }
  create(
    market: MarketContext,
    conversation: ConversationRecord & { startedAt: Temporal.Instant },
  ) {
    if (this.rows.has(conversation.id)) return Promise.resolve(false);
    if (conversation.retentionDays > 0 && this.destroyed.has(conversation.id)) {
      return Promise.resolve(false);
    }
    this.started.set(conversation.id, conversation.startedAt);
    this.rows.set(conversation.id, {
      ...conversation,
      market: market.marketId,
      lastAt: conversation.startedAt,
    });
    return Promise.resolve(true);
  }
  history(_market: MarketContext, id: string, limit: number) {
    return Promise.resolve(
      (this.messages.get(id) ?? []).slice(-limit).map(({ role, text }) => ({ role, text })),
    );
  }
  countTurn(_market: MarketContext, id: string, expectedTurns: number, at: Temporal.Instant) {
    const row = this.rows.get(id);
    if (row === undefined || row.turns !== expectedTurns) return Promise.resolve(false);
    this.rows.set(id, { ...row, turns: expectedTurns + 1, lastAt: at });
    return Promise.resolve(true);
  }
  append(
    _market: MarketContext,
    id: string,
    message: StoredMessage & { cards: readonly string[]; at: Temporal.Instant },
  ) {
    const list = this.messages.get(id) ?? [];
    list.push({ role: message.role, text: message.text, cards: message.cards });
    this.messages.set(id, list);
    this.times.set(id, [...(this.times.get(id) ?? []), message.at]);
    return Promise.resolve();
  }
  /** When each conversation started, for the admin's read (set by `create`). */
  readonly started = new Map<string, Temporal.Instant>();
  datesOfAccount(
    market: MarketContext,
    accountId: Id<'Account'>,
    direction: 'asc' | 'desc',
    window: { readonly offset: number; readonly limit: number },
  ) {
    const sign = direction === 'asc' ? 1 : -1;
    return Promise.resolve(
      this.ofAccount(market, accountId)
        .map(([id, row]) => ({ id, startedAt: this.started.get(id)!, lastMessageAt: row.lastAt }))
        .sort(
          (a, b) =>
            sign * (Temporal.Instant.compare(a.startedAt, b.startedAt) || a.id.localeCompare(b.id)),
        )
        .slice(window.offset, window.offset + window.limit)
        .map(({ startedAt, lastMessageAt }) => ({ startedAt, lastMessageAt })),
    );
  }
  countOfAccount(market: MarketContext, accountId: Id<'Account'>) {
    return Promise.resolve(this.ofAccount(market, accountId).length);
  }
  private ofAccount(market: MarketContext, accountId: Id<'Account'>) {
    return [...this.rows].filter(
      ([, row]) =>
        row.market === market.marketId &&
        row.owner.kind === 'account' &&
        row.owner.accountId === accountId,
    );
  }
  purgeExpired(
    market: MarketContext,
    now: Temporal.Instant,
    currentDays: { customer: number; guest: number },
    limit: number,
  ) {
    let purged = 0;
    for (const [id, row] of this.rows) {
      if (purged >= limit || row.market !== market.marketId) continue;
      const kind = row.owner.kind === 'account' ? 'customer' : 'guest';
      const days = Math.max(1, Math.min(row.retentionDays, currentDays[kind]));
      if (Temporal.Instant.compare(row.lastAt.add({ hours: 24 * days }), now) < 0) {
        this.rows.delete(id);
        this.messages.delete(id);
        if (row.retentionDays > 0) this.destroyed.add(id);
        purged += 1;
      }
    }
    return Promise.resolve(purged);
  }
}

/** Spend per Market and day in memory. */
export class MemorySpend implements SpendRepository {
  readonly days = new Map<
    string,
    {
      microUsd: number;
      conversations: number;
      autoOff: { at: Temporal.Instant; cap: 'daily' | 'monthly' } | null;
    }
  >();

  #key = (market: MarketContext, day: Temporal.PlainDate) => `${market.marketId}:${day.toString()}`;

  totals(market: MarketContext, day: Temporal.PlainDate): Promise<SpendTotals> {
    let month = 0;
    let lastAutoOff: SpendTotals['lastAutoOff'] = null;
    for (const [key, value] of this.days) {
      const [marketId, date] = key.split(':') as [string, string];
      if (marketId !== market.marketId) continue;
      const plain = Temporal.PlainDate.from(date);
      if (
        plain.year === day.year &&
        plain.month === day.month &&
        Temporal.PlainDate.compare(plain, day) <= 0
      ) {
        month += value.microUsd;
      }
      if (
        value.autoOff !== null &&
        (lastAutoOff === null || Temporal.Instant.compare(value.autoOff.at, lastAutoOff.at) > 0)
      ) {
        lastAutoOff = value.autoOff;
      }
    }
    const today = this.days.get(this.#key(market, day));
    return Promise.resolve({
      todayMicroUsd: today?.microUsd ?? 0,
      monthMicroUsd: month,
      conversationsToday: today?.conversations ?? 0,
      lastAutoOff,
    });
  }
  add(
    market: MarketContext,
    day: Temporal.PlainDate,
    spend: Parameters<SpendRepository['add']>[2],
  ) {
    const key = this.#key(market, day);
    const row = this.days.get(key) ?? { microUsd: 0, conversations: 0, autoOff: null };
    this.days.set(key, {
      ...row,
      microUsd: row.microUsd + spend.microUsd,
      conversations: row.conversations + spend.conversations,
    });
    return Promise.resolve();
  }
  markAutoOff(
    market: MarketContext,
    day: Temporal.PlainDate,
    cap: 'daily' | 'monthly',
    at: Temporal.Instant,
  ) {
    const key = this.#key(market, day);
    const row = this.days.get(key);
    if (row === undefined || row.autoOff !== null) return Promise.resolve(false);
    this.days.set(key, { ...row, autoOff: { at, cap } });
    return Promise.resolve(true);
  }
}

/** Counts per subject, with no window: a spec sets the counts it needs. */
export class MemoryLimits implements MessageLimits {
  readonly counts = new Map<string, number>();
  failing = false;
  count(subject: string) {
    if (this.failing) return Promise.reject(new Error('counter down'));
    const count = (this.counts.get(subject) ?? 0) + 1;
    this.counts.set(subject, count);
    return Promise.resolve({ count, retryAfterSeconds: 120 });
  }
}

/** Tokens numbered in order; the hash is the real SHA-256. */
export class SequenceGuestTokens implements GuestTokens {
  #next = 0;
  issue() {
    const token = `guest-token-${String(this.#next++).padStart(31, '0')}`;
    return { token, hash: this.hashOf(token)! };
  }
  hashOf(token: string) {
    return /^[A-Za-z0-9_-]{43}$/.test(token)
      ? createHash('sha256').update(token).digest('hex')
      : null;
  }
}

/** Collects events with their Market, each checked against its definition as the writer does. */
export class RecordingOutbox implements OutboxWriter {
  readonly events: (PendingEvent & { marketId: string })[] = [];
  append(context: CallContext, events: readonly PendingEvent[]): Promise<void> {
    for (const event of events) {
      const definition = ASSISTANT_EVENTS.find((d) => d.type === event.type);
      if (definition === undefined) throw new Error(`outbox: unknown type ${event.type}`);
      const checked = encodePayload(definition.fields, event.payload, NO_PERMISSION_KEYS);
      if (!checked.ok) throw new Error(`outbox: ${JSON.stringify(checked.error)}`);
      this.events.push({ ...event, marketId: context.market.marketId });
    }
    return Promise.resolve();
  }
}

/**
 * Fixed prompts shaped like the fixtures: ZZ answers Japanese (its default, with no English
 * catalogue), AU English unless asked for `ja`; records each tag asked.
 */
export class FixedQuickPrompts implements QuickPrompts {
  static readonly JA = ['今週の特売は？'];
  static readonly EN = ['What is on special?'];
  readonly asked: (string | null)[] = [];
  forBuyer(market: MarketContext, lang: string | null) {
    this.asked.push(lang);
    return market.marketId === 'ZZ' || lang?.startsWith('ja')
      ? FixedQuickPrompts.JA
      : FixedQuickPrompts.EN;
  }
}

/**
 * Preview tokens: `preview:<Market>:<expiry ms>`, valid until the expiry and for that Market only;
 * `available` switches the key off.
 */
export class FakePreviewTokens implements PreviewTokens {
  available_ = true;
  available() {
    return this.available_;
  }
  issue(market: MarketContext, now: Temporal.Instant) {
    if (!this.available_) return null;
    const expiresAt = now.add({ minutes: 30 });
    return { token: `preview:${market.marketId}:${expiresAt.epochMilliseconds}`, expiresAt };
  }
  verify(market: MarketContext, token: unknown, now: Temporal.Instant) {
    if (!this.available_ || typeof token !== 'string') return false;
    const [kind, marketId, expiry] = token.split(':');
    return (
      kind === 'preview' && marketId === market.marketId && Number(expiry) > now.epochMilliseconds
    );
  }
}

/** The day in UTC. */
export class UtcCalendar implements MarketCalendar {
  dayOf(_market: MarketContext, at: Temporal.Instant) {
    return at.toZonedDateTimeISO('UTC').toPlainDate();
  }
}
