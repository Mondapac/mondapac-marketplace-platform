import { unusedChangeTrail } from '../../../../test/support/change-trail-fakes';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '../domain/assistant-settings';
import type { AssistantDependencies } from './assistant-dependencies';
import type {
  AssistantSettingsRecord,
  AssistantSettingsRepository,
} from './ports/assistant-settings.repository';
import {
  answer,
  FakeRuntime,
  FakeTools,
  FakeInsights,
  MemoryConversations,
  MemoryFeedback,
  MemoryLimits,
  MemorySpend,
  SequenceGuestTokens,
  UtcCalendar,
} from './testing/assistant-fakes';
import { SubmitFeedback } from './use-cases/submit-feedback.use-case';
import { SubmitGuestFeedback } from './use-cases/submit-guest-feedback.use-case';
import { ViewAssistantInsights } from './use-cases/view-assistant-insights.use-case';
import { SendGuestMessage } from './use-cases/send-guest-message.use-case';
import { SendMessage } from './use-cases/send-message.use-case';

// B3: thumbs and insights on both Market fixtures, against the in-memory ports. A conversation is
// built by sending real messages through the use cases, so the stored flags are the real ones.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-19T21:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const OTHER_CUSTOMER = id<'Account'>(0xc2);
const CONVERSATION = '0199aaaa-0000-7000-8000-000000000001';
const SECOND = '0199aaaa-0000-7000-8000-000000000002';
const VISITOR = 'visitor-key-0123456789';

class OneSettings implements AssistantSettingsRepository {
  current: AssistantSettings | null = null;
  latest(): Promise<AssistantSettingsRecord | null> {
    return Promise.resolve(
      this.current === null ? null : { version: 1, settings: this.current, changedAt: T0 },
    );
  }
  append() {
    return Promise.resolve(false);
  }
}

const on = (overrides: Partial<AssistantSettings> = {}): AssistantSettings => ({
  ...DEFAULT_ASSISTANT_SETTINGS,
  enabled: true,
  audience: 'all',
  ...overrides,
});

describe.each(TEST_MARKET_IDS)('assistant feedback and insights in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let settings: OneSettings;
  let runtime: FakeRuntime;
  let tools: FakeTools;
  let conversations: MemoryConversations;
  let feedback: MemoryFeedback;
  let insights: FakeInsights;
  let clock: FixedClock;
  let deps: AssistantDependencies;

  const customer = (accountId: Id<'Account'> = CUSTOMER) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'assistant-customer-abcd',
    );
  const seller = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: id<'Account'>(0xa1),
        sessionId: id<'Session'>(0x62),
        sellerId: id<'Seller'>(0x51),
      }),
      'assistant-seller-abcd',
    );
  const admin = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: id<'Account'>(0xad),
        sessionId: id<'Session'>(0x63),
        sellerId: null,
      }),
      'assistant-admin-abcd',
    );
  const guest = () => testCallContext(market, 'anonymous');

  beforeEach(() => {
    settings = new OneSettings();
    settings.current = on();
    runtime = new FakeRuntime();
    tools = new FakeTools();
    conversations = new MemoryConversations();
    feedback = new MemoryFeedback(conversations);
    insights = new FakeInsights();
    clock = new FixedClock(T0);
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      settings,
      runtime,
      audit: { record: () => Promise.resolve() },
      clock,
      conversations,
      feedback,
      insights,
      spend: new MemorySpend(),
      tools,
      limits: new MemoryLimits(),
      guestTokens: new SequenceGuestTokens(),
      calendar: new UtcCalendar(),
      trail: unusedChangeTrail,
    };
  });

  const chat = async (conversationId = CONVERSATION, accountId = CUSTOMER) => {
    const sent = await new SendMessage(gate, deps).execute(customer(accountId), {
      conversationId,
      text: 'Do you have lamb?',
      visitor: VISITOR,
    });
    expect(sent.ok).toBe(true);
  };
  const guestChat = async () => {
    const sent = await new SendGuestMessage(gate, deps).execute(guest(), {
      conversationId: SECOND,
      text: 'Hi',
      visitor: VISITOR,
      token: null,
      origin: '203.0.113.7',
    });
    if (!sent.ok || sent.value.guestToken === null) throw new Error('no guest token');
    return sent.value.guestToken;
  };
  const thumbs = (
    input: Partial<Parameters<SubmitFeedback['execute']>[1]> = {},
    context = customer(),
  ) =>
    new SubmitFeedback(gate, deps).execute(context, {
      conversationId: CONVERSATION,
      messageId: '2',
      rating: 'down',
      reason: 'wrong',
      ...input,
    });
  const guestThumbs = (token: string | null, input: Record<string, unknown> = {}) =>
    new SubmitGuestFeedback(gate, deps).execute(guest(), {
      conversationId: SECOND,
      messageId: '2',
      rating: 'up',
      reason: undefined,
      token,
      ...input,
    });

  describe('what a reply stores for the insights', () => {
    it('keeps the notices and an empty product search with the assistant message only', async () => {
      runtime.script.push(
        answer({ calls: [{ id: 'c1', name: 'search_products', input: { text: 'unicorn' } }] }),
        answer({ text: 'I could not find that.' }),
      );
      tools.emptySearch = true;
      await chat();
      const [buyer, reply] = conversations.messages.get(CONVERSATION)!;
      expect(buyer).toMatchObject({ role: 'buyer', notices: [], emptySearch: false });
      expect(reply).toMatchObject({ role: 'assistant', emptySearch: true });
    });

    it('keeps tool-failed', async () => {
      tools.failing = true;
      runtime.script.push(
        answer({ calls: [{ id: 'c1', name: 'search_products', input: { text: 'lamb' } }] }),
        answer({ text: 'Sorry, I could not check.' }),
      );
      await chat();
      expect(conversations.messages.get(CONVERSATION)![1]!.notices).toContain('tool-failed');
    });
  });

  describe('giving feedback', () => {
    it('stores a thumbs down with its reason on an assistant message, then replaces it', async () => {
      await chat();
      const down = await thumbs();
      expect(down).toEqual({ ok: true, value: { rating: 'down', reason: 'wrong' } });
      expect(feedback.rows.get(`${CONVERSATION}:2`)).toMatchObject({
        rating: 'down',
        reason: 'wrong',
      });

      const up = await thumbs({ rating: 'up', reason: undefined });
      expect(up).toEqual({ ok: true, value: { rating: 'up', reason: null } });
      expect(feedback.rows.size).toBe(1);
      expect(feedback.rows.get(`${CONVERSATION}:2`)).toMatchObject({ rating: 'up', reason: null });
    });

    it('gives a guest the same, on the conversation its own cookie started', async () => {
      const token = await guestChat();
      expect(await guestThumbs(token)).toEqual({ ok: true, value: { rating: 'up', reason: null } });
      expect(feedback.rows.has(`${SECOND}:2`)).toBe(true);
    });

    it('answers 404 for another buyer, another guest and a guest with no cookie', async () => {
      await chat();
      const notYours = { ok: false, error: { code: 'assistant.conversation-not-found' } };
      expect(await thumbs({}, customer(OTHER_CUSTOMER))).toEqual(notYours);
      const token = await guestChat();
      // A guest cannot reach a customer's conversation, nor a customer a guest's.
      expect(await guestThumbs(token, { conversationId: CONVERSATION })).toEqual(notYours);
      expect(await thumbs({ conversationId: SECOND })).toEqual(notYours);
      expect(await guestThumbs(null)).toEqual(notYours);
      expect(await guestThumbs('not-a-token')).toEqual(notYours);
      expect(await guestThumbs('A'.repeat(43))).toEqual(notYours);
      expect(await thumbs({ conversationId: '0199aaaa-0000-7000-8000-0000000000ff' })).toEqual(
        notYours,
      );
      expect(feedback.rows.size).toBe(0);
    });

    it('takes only an assistant message that exists', async () => {
      await chat();
      const missing = { ok: false, error: { code: 'assistant.message-not-found' } };
      expect(await thumbs({ messageId: '1' })).toEqual(missing); // the buyer's own line
      expect(await thumbs({ messageId: '3' })).toEqual(missing);
      expect(await thumbs({ messageId: '60' })).toEqual(missing);
      expect(feedback.rows.size).toBe(0);
    });

    it('keeps nothing for a conversation that keeps no text', async () => {
      settings.current = on({ retention: 'none' });
      await chat();
      expect(await thumbs()).toEqual({
        ok: false,
        error: { code: 'assistant.message-not-found' },
      });
    });

    it.each<[string, Record<string, unknown>, string]>([
      ['a reason with a thumbs up', { rating: 'up', reason: 'wrong' }, 'reason'],
      ['an unknown reason', { reason: 'rude' }, 'reason'],
      ['an unknown rating', { rating: 'five' }, 'rating'],
      ['a missing rating', { rating: undefined, reason: undefined }, 'rating'],
      ['a message id of 0', { messageId: '0' }, 'messageId'],
      ['a message id of 61', { messageId: '61' }, 'messageId'],
      ['a message id that is not digits', { messageId: '2; drop' }, 'messageId'],
      ['a conversation id that is not a UUID', { conversationId: 'abc' }, 'id'],
    ])('refuses %s', async (_label, input, path) => {
      await chat();
      const result = await thumbs(input);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatchObject({
        code: 'validation.failed',
        fields: [expect.objectContaining({ path })],
      });
      expect(feedback.rows.size).toBe(0);
    });

    it('is off with the Market switch, and never for a seller on the customer route', async () => {
      await chat();
      settings.current = on({ enabled: false });
      expect(await thumbs()).toEqual({ ok: false, error: { code: 'assistant.off' } });
      settings.current = on();
      expect(await thumbs({}, seller())).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(feedback.rows.size).toBe(0);
    });
  });

  describe('the admin insights', () => {
    const read = (query: Record<string, unknown> = {}) =>
      new ViewAssistantInsights(gate, deps).execute(admin(), query);

    it('fills every day of the range, totals them, and shares the thumbs', async () => {
      insights.dayRows = [
        { day: Temporal.PlainDate.from('2026-10-18'), conversations: 3, spendMicroUsd: 1500 },
        { day: Temporal.PlainDate.from('2026-10-20'), conversations: 2, spendMicroUsd: 500 },
      ];
      insights.feedbackTotals = { up: 3, down: 1, reasons: { wrong: 1, 'not-found': 0, other: 0 } };
      insights.handoffCount = 4;
      const result = await read({ from: '2026-10-18', to: '2026-10-21' });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(
        result.value.days.map((d) => [d.day.toString(), d.conversations, d.spendMicroUsd]),
      ).toEqual([
        ['2026-10-18', 3, 1500],
        ['2026-10-19', 0, 0],
        ['2026-10-20', 2, 500],
        ['2026-10-21', 0, 0],
      ]);
      expect(result.value.totals).toEqual({ conversations: 5, spendMicroUsd: 2000 });
      expect(result.value.feedback).toMatchObject({ up: 3, down: 1, upShare: 0.75 });
      expect(result.value.handoffs).toBe(4);
      // The range is the Market's days, read as [start of from, start of the day after to).
      expect(insights.asked[0]).toMatchObject({
        from: Temporal.Instant.from('2026-10-18T00:00:00Z'),
        to: Temporal.Instant.from('2026-10-22T00:00:00Z'),
      });
    });

    it('has no share without thumbs, and defaults to the last 30 days', async () => {
      const result = await read();
      expect(result.ok && result.value.feedback.upShare).toBeNull();
      expect(result.ok && result.value.days).toHaveLength(30);
      expect(result.ok && result.value.to.toString()).toBe('2026-10-19');
    });

    it('groups the unanswered turns, masked text only, and pages them', async () => {
      insights.candidates = [
        { text: 'saffron?', at: T0, reasons: ['no-results'] },
        { text: 'Saffron', at: T0.add({ hours: 1 }), reasons: ['thumbs-down'] },
        { text: 'dates', at: T0.add({ hours: 2 }), reasons: ['unavailable'] },
        { text: 'ghee', at: T0.add({ hours: 3 }), reasons: ['tool-failed'] },
      ];
      const first = await read({ pageSize: '2' });
      expect(first.ok && first.value.unanswered).toMatchObject({
        total: 3,
        page: 1,
        pageSize: 2,
        truncated: false,
      });
      expect(first.ok && first.value.unanswered.rows.map((r) => [r.query, r.count])).toEqual([
        ['Saffron', 2],
        ['ghee', 1],
      ]);
      const second = await read({ pageSize: '2', page: '2' });
      expect(second.ok && second.value.unanswered.rows.map((r) => r.query)).toEqual(['dates']);
      const beyond = await read({ pageSize: '2', page: '9' });
      expect(beyond.ok && beyond.value.unanswered.rows).toEqual([]);
    });

    it('says when more flagged turns existed than were read', async () => {
      insights.candidates = Array.from({ length: 1001 }, (_, index) => ({
        text: `q${index}`,
        at: T0,
        reasons: ['no-results' as const],
      }));
      const result = await read();
      expect(result.ok && result.value.unanswered.truncated).toBe(true);
      expect(insights.asked[0]!.limit).toBe(1001);
      expect(result.ok && result.value.unanswered.total).toBe(200);
    });

    it('refuses a bad query', async () => {
      expect(await read({ from: '2026-10-19', to: '2026-10-01' })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'from', code: 'range' }] },
      });
      expect(insights.asked).toHaveLength(0);
    });
  });
});
