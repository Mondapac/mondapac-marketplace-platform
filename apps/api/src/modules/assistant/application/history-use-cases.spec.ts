import { unusedChangeTrail } from '../../../../test/support/change-trail-fakes';
import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { DEFAULT_ASSISTANT_SETTINGS, type AssistantSettings } from '../domain/assistant-settings';
import type { AssistantCard } from '../domain/cards';
import { MASKED } from '../domain/personal-data';
import type { AssistantDependencies } from './assistant-dependencies';
import { conversationTitle, storedCardOf } from '../domain/conversation';
import { decodeCursor, encodeCursor } from './history-flow';
import type {
  AssistantSettingsRecord,
  AssistantSettingsRepository,
} from './ports/assistant-settings.repository';
import {
  answer,
  FakePreviewTokens,
  FakeRuntime,
  FakeTools,
  FixedQuickPrompts,
  MemoryConversations,
  MemoryLimits,
  MemorySpend,
  SequenceGuestTokens,
  UtcCalendar,
} from './testing/assistant-fakes';
import { DeleteConversation } from './use-cases/delete-conversation.use-case';
import { ListConversations } from './use-cases/list-conversations.use-case';
import { SendGuestMessage } from './use-cases/send-guest-message.use-case';
import { SendMessage } from './use-cases/send-message.use-case';
import { ViewConversation } from './use-cases/view-conversation.use-case';

// A signed-in buyer's own conversation history (stage 0, B2), in memory on both Market fixtures:
// the list within the retention in force, newest first and paged; titles masked and cut; one
// conversation's transcript with its card refs; continuing it with the existing message route;
// deleting it; and every other caller (another customer, a guest's conversation, a seller)
// answered as not found or refused.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-19T21:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const conversationId = (n: number) => `0199aaaa-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const CUSTOMER = id<'Account'>(0xc1);
const OTHER_CUSTOMER = id<'Account'>(0xc2);
const VISITOR = 'visitor-key-0123456789';

class NoAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry) {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

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
  retention: '12-months',
  ...overrides,
});

const PRODUCT: AssistantCard = {
  kind: 'product',
  offerId: id<'Offer'>(0x0f1),
  productId: id<'Product'>(0x0e1),
  sellerId: id<'Seller'>(0x051),
  name: 'Lamb mince 500 g',
  shortText: null,
  price: null,
  regularPrice: null,
  taxInclusive: null,
};

describe.each(TEST_MARKET_IDS)('assistant conversation history in market %s', (code) => {
  const market: MarketContext = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let settings: OneSettings;
  let runtime: FakeRuntime;
  let tools: FakeTools;
  let conversations: MemoryConversations;
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
      'assistant-history-abcd',
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

  beforeEach(() => {
    settings = new OneSettings();
    settings.current = on();
    runtime = new FakeRuntime();
    tools = new FakeTools();
    conversations = new MemoryConversations();
    clock = new FixedClock(T0);
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      settings,
      runtime,
      audit: new NoAudit(),
      clock,
      conversations,
      spend: new MemorySpend(),
      tools,
      limits: new MemoryLimits(),
      guestTokens: new SequenceGuestTokens(),
      calendar: new UtcCalendar(),
      quickPrompts: new FixedQuickPrompts(),
      previewTokens: new FakePreviewTokens(),
      trail: unusedChangeTrail,
    };
  });

  const send = (text: string, conversation: string, context = customer()) =>
    new SendMessage(gate, deps).execute(context, {
      conversationId: conversation,
      text,
      visitor: VISITOR,
    });
  const list = (input: { cursor?: unknown; limit?: unknown } = {}, context = customer()) =>
    new ListConversations(gate, deps).execute(context, input);
  const view = (conversation: unknown, context = customer()) =>
    new ViewConversation(gate, deps).execute(context, { conversationId: conversation });
  const remove = (conversation: unknown, context = customer()) =>
    new DeleteConversation(gate, deps).execute(context, { conversationId: conversation });
  const later = (hours: number) => clock.set(clock.now().add({ hours }));

  describe('the list', () => {
    it("lists only the buyer's own conversations that keep text, newest first", async () => {
      await send('Do you have lamb mince?', conversationId(1));
      later(1);
      await send('Write to me at shopper@example.com about dates please', conversationId(2));
      later(1);
      await send('Mine too', conversationId(3), customer(OTHER_CUSTOMER));
      await new SendGuestMessage(gate, deps).execute(testCallContext(market, 'anonymous'), {
        conversationId: conversationId(4),
        text: 'guest',
        visitor: VISITOR,
        token: null,
        origin: '203.0.113.7',
      });
      settings.current = on({ retention: 'none' });
      await send('Not kept', conversationId(5));
      settings.current = on();

      const result = await list();

      expect(result.ok && result.value).toEqual({
        items: [
          {
            id: conversationId(2),
            title: `Write to me at ${MASKED} about…`,
            turns: 1,
            full: false,
            startedAt: T0.add({ hours: 1 }),
            lastMessageAt: T0.add({ hours: 1 }),
          },
          {
            id: conversationId(1),
            title: 'Do you have lamb mince?',
            turns: 1,
            full: false,
            startedAt: T0,
            lastMessageAt: T0,
          },
        ],
        nextCursor: null,
      });
      expect(
        [...(result.ok ? result.value.items : [])].every((item) => item.title.length <= 30),
      ).toBe(true);
    });

    it('moves a continued conversation to the top', async () => {
      await send('First', conversationId(1));
      later(1);
      await send('Second', conversationId(2));
      later(1);
      await send('First again', conversationId(1));

      const result = await list();

      expect(result.ok && result.value.items.map((item) => [item.id, item.turns])).toEqual([
        [conversationId(1), 2],
        [conversationId(2), 1],
      ]);
    });

    it('follows the retention in force: a shorter setting hides older conversations', async () => {
      await send('Old', conversationId(1));
      later(24 * 40);
      await send('Recent', conversationId(2));

      const kept = await list();
      settings.current = on({ retention: '30-days' });
      const shorter = await list();
      settings.current = on({ retention: 'none' });
      const none = await list();

      expect(kept.ok && kept.value.items.map((item) => item.id)).toEqual([
        conversationId(2),
        conversationId(1),
      ]);
      expect(shorter.ok && shorter.value.items.map((item) => item.id)).toEqual([conversationId(2)]);
      expect(none.ok && none.value.items).toEqual([]);
    });

    it('pages by an opaque cursor and refuses a bad cursor or limit', async () => {
      for (let n = 1; n <= 5; n += 1) {
        await send(`Question ${n}`, conversationId(n));
        later(1);
      }

      const first = await list({ limit: '2' });
      const cursor = first.ok ? first.value.nextCursor : null;
      const second = await list({ limit: 2, cursor });
      const third = await list({ limit: 2, cursor: second.ok ? second.value.nextCursor : null });

      const ids = (page: typeof first) => (page.ok ? page.value.items.map((item) => item.id) : []);
      expect(ids(first)).toEqual([conversationId(5), conversationId(4)]);
      expect(ids(second)).toEqual([conversationId(3), conversationId(2)]);
      expect(ids(third)).toEqual([conversationId(1)]);
      expect(third.ok && third.value.nextCursor).toBeNull();

      expect(await list({ limit: 0 })).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'limit', code: 'range' }] },
      });
      expect(await list({ limit: '51', cursor: 'not a cursor!' })).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'cursor', code: 'format' },
            { path: 'limit', code: 'range' },
          ],
        },
      });
      const forged = Buffer.from('12.not-an-id', 'utf8').toString('base64url');
      expect(await list({ cursor: forged })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });

    it('pages through conversations with the same last message time, newest id first', async () => {
      for (const n of [3, 1, 2]) await send(`Same time ${n}`, conversationId(n));

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < 4; page += 1) {
        const result = await list({ limit: 1, cursor });
        if (!result.ok) throw new Error('list failed');
        seen.push(...result.value.items.map((item) => item.id));
        cursor = result.value.nextCursor;
        if (cursor === null) break;
      }

      expect(seen).toEqual([conversationId(3), conversationId(2), conversationId(1)]);
    });

    it('lists and opens a conversation exactly at the retention edge, not 1 ms past it', async () => {
      settings.current = on({ retention: '30-days' });
      await send('Edge', conversationId(1));
      clock.set(T0.add({ hours: 24 * 30 }));

      const atEdge = await list();
      expect(atEdge.ok && atEdge.value.items.map((item) => item.id)).toEqual([conversationId(1)]);
      expect((await view(conversationId(1))).ok).toBe(true);

      clock.set(T0.add({ hours: 24 * 30, milliseconds: 1 }));
      expect((await list()).ok && (await list())).toMatchObject({ value: { items: [] } });
      expect(await view(conversationId(1))).toEqual({
        ok: false,
        error: { code: 'assistant.conversation-not-found' },
      });
    });

    it.each<[string, unknown, boolean]>([
      ['absent', undefined, true],
      ['the maximum', '50', true],
      ['a number', 50, true],
      ['an array', ['1', '2'], false],
      ['a fraction', '2.5', false],
      ['padded', ' 2', false],
      ['over the maximum', 51, false],
      ['negative', '-1', false],
    ])('takes a limit that is %s: %s', async (_label, limit, accepted) => {
      const result = await list({ limit });
      expect(result.ok).toBe(accepted);
    });

    it('refuses a cursor longer than 96 characters', async () => {
      expect(await list({ cursor: 'a'.repeat(97) })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'cursor', code: 'format' }] },
      });
    });

    it('moves the page on past a conversation whose key is already destroyed', async () => {
      for (let n = 1; n <= 3; n += 1) {
        await send(`Question ${n}`, conversationId(n));
        later(1);
      }
      // A purge or delete in flight: the row is still there, its key is gone.
      conversations.destroyed.add(conversationId(3));

      const first = await list({ limit: 2 });
      const second = await list({ limit: 2, cursor: first.ok ? first.value.nextCursor : null });

      const ids = (page: typeof first) => (page.ok ? page.value.items.map((item) => item.id) : []);
      expect(ids(first)).toEqual([conversationId(2)]);
      expect(first.ok && first.value.nextCursor).not.toBeNull();
      expect(ids(second)).toEqual([conversationId(1)]);
      expect(second.ok && second.value.nextCursor).toBeNull();
    });

    it('leaves out a conversation with no stored buyer message, and still pages on', async () => {
      await send('Older', conversationId(1));
      later(1);
      await send('Newer', conversationId(2));
      // A turn counted but its text not stored (another request took it first).
      conversations.messages.delete(conversationId(2));
      conversations.times.delete(conversationId(2));

      const first = await list({ limit: 1 });
      const second = await list({ limit: 1, cursor: first.ok ? first.value.nextCursor : null });

      expect(first.ok && first.value.items).toEqual([]);
      expect(first.ok && first.value.nextCursor).not.toBeNull();
      expect(second.ok && second.value.items.map((item) => item.id)).toEqual([conversationId(1)]);
    });

    it('is off while the assistant is off, and refuses a seller', async () => {
      settings.current = on({ enabled: false });
      expect(await list()).toEqual({ ok: false, error: { code: 'assistant.off' } });
      settings.current = null;
      expect(await list()).toEqual({ ok: false, error: { code: 'assistant.off' } });
      settings.current = on();
      expect(await list({}, seller())).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('one conversation', () => {
    it('answers every stored message in order with its card refs, never a price', async () => {
      tools.products = [PRODUCT];
      runtime.script.push(
        answer({ calls: [{ id: 'c1', name: 'search_products', input: { text: 'lamb' } }] }),
        answer({ text: 'Here is some lamb mince.' }),
      );
      await send('Lamb please, call 0412 345 678', conversationId(1));
      later(1);
      await send('Thanks', conversationId(1));

      const result = await view(conversationId(1));

      expect(result.ok && result.value).toEqual({
        id: conversationId(1),
        title: `Lamb please, call ${MASKED}`,
        turns: 2,
        full: false,
        startedAt: T0,
        lastMessageAt: T0.add({ hours: 1 }),
        messages: [
          {
            position: 1,
            role: 'buyer',
            text: `Lamb please, call ${MASKED}`,
            cards: [],
            at: T0,
          },
          {
            position: 2,
            role: 'assistant',
            text: 'Here is some lamb mince.',
            cards: [
              { kind: 'product', offerId: PRODUCT.kind === 'product' ? PRODUCT.offerId : '' },
            ],
            at: T0,
          },
          { position: 3, role: 'buyer', text: 'Thanks', cards: [], at: T0.add({ hours: 1 }) },
          {
            position: 4,
            role: 'assistant',
            text: 'How can I help?',
            cards: [],
            at: T0.add({ hours: 1 }),
          },
        ],
      });
    });

    it("answers another buyer's, a guest's, an unknown or an expired conversation as not found", async () => {
      await send('Mine', conversationId(1));
      await new SendGuestMessage(gate, deps).execute(testCallContext(market, 'anonymous'), {
        conversationId: conversationId(2),
        text: 'guest',
        visitor: VISITOR,
        token: null,
        origin: '203.0.113.7',
      });
      const notFound = { ok: false, error: { code: 'assistant.conversation-not-found' } };

      expect(await view(conversationId(1), customer(OTHER_CUSTOMER))).toEqual(notFound);
      expect(await view(conversationId(2))).toEqual(notFound);
      expect(await view(conversationId(9))).toEqual(notFound);
      expect(await view('not-an-id')).toEqual({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'id', code: 'format' }] },
      });
      settings.current = on({ retention: '30-days' });
      later(24 * 31);
      expect(await view(conversationId(1))).toEqual(notFound);
    });

    it('continues an old conversation through the message route, with its history', async () => {
      await send('Do you sell dates?', conversationId(1));
      later(24 * 10);

      const continued = await send('And figs?', conversationId(1));

      expect(continued.ok).toBe(true);
      const lastRequest = runtime.requests.at(-1)!;
      expect(lastRequest.messages.map((message) => message.role)).toEqual([
        'user',
        'assistant',
        'user',
      ]);
      const listed = await list();
      expect(listed.ok && listed.value.items[0]).toMatchObject({ id: conversationId(1), turns: 2 });
    });

    it('marks a full conversation, and the message route answers 409 for it', async () => {
      for (let turn = 0; turn < 30; turn += 1) await send(`Message ${turn}`, conversationId(1));

      const listed = await list();
      expect(listed.ok && listed.value.items[0]).toMatchObject({ turns: 30, full: true });
      expect(await send('One more', conversationId(1))).toEqual({
        ok: false,
        error: { code: 'assistant.conversation-full' },
      });
    });
  });

  describe('one conversation, more cases', () => {
    it('is off while the assistant is off, and not found when it kept no text', async () => {
      settings.current = on({ retention: 'none' });
      await send('Not kept', conversationId(1));
      settings.current = on();
      expect(await view(conversationId(1))).toEqual({
        ok: false,
        error: { code: 'assistant.conversation-not-found' },
      });
      settings.current = on({ enabled: false });
      expect(await view(conversationId(1))).toEqual({
        ok: false,
        error: { code: 'assistant.off' },
      });
    });
  });

  describe('deleting', () => {
    it("deletes the buyer's own conversation and its key, even while the assistant is off", async () => {
      await send('Delete me', conversationId(1));
      await send('Keep me', conversationId(2));
      settings.current = on({ enabled: false });

      expect(await remove(conversationId(1))).toEqual({ ok: true, value: { deleted: true } });
      expect(conversations.destroyed.has(conversationId(1))).toBe(true);
      expect(await remove(conversationId(1))).toEqual({
        ok: false,
        error: { code: 'assistant.conversation-not-found' },
      });

      settings.current = on();
      expect(await view(conversationId(1))).toEqual({
        ok: false,
        error: { code: 'assistant.conversation-not-found' },
      });
      const listed = await list();
      expect(listed.ok && listed.value.items.map((item) => item.id)).toEqual([conversationId(2)]);
    });

    it('refuses a deleted id before any model call, so nothing escapes the spend caps', async () => {
      await send('Delete me', conversationId(1));
      await remove(conversationId(1));
      const calls = runtime.requests.length;

      expect(await send('Again', conversationId(1))).toEqual({
        ok: false,
        error: { code: 'assistant.conversation-not-found' },
      });
      expect(runtime.requests).toHaveLength(calls);
    });

    it('refuses a purged id the same way, on the customer and the guest route', async () => {
      await send('Old', conversationId(1));
      const guestReply = await new SendGuestMessage(gate, deps).execute(
        testCallContext(market, 'anonymous'),
        {
          conversationId: conversationId(2),
          text: 'Hi',
          visitor: VISITOR,
          token: null,
          origin: '203.0.113.7',
        },
      );
      const token = guestReply.ok ? guestReply.value.guestToken : null;
      later(24 * 400);
      await conversations.purgeExpired(market, clock.now(), { customer: 365, guest: 30 }, 100);
      const calls = runtime.requests.length;

      expect(await send('Again', conversationId(1))).toEqual({
        ok: false,
        error: { code: 'assistant.conversation-not-found' },
      });
      expect(
        await new SendGuestMessage(gate, deps).execute(testCallContext(market, 'anonymous'), {
          conversationId: conversationId(2),
          text: 'Again',
          visitor: VISITOR,
          token,
          origin: '203.0.113.8',
        }),
      ).toEqual({ ok: false, error: { code: 'assistant.conversation-not-found' } });
      expect(runtime.requests).toHaveLength(calls);
    });

    it("never deletes another buyer's conversation, and refuses a seller", async () => {
      await send('Mine', conversationId(1));

      expect(await remove(conversationId(1), customer(OTHER_CUSTOMER))).toEqual({
        ok: false,
        error: { code: 'assistant.conversation-not-found' },
      });
      expect(await remove(conversationId(1), seller())).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(conversations.rows.has(conversationId(1))).toBe(true);
    });
  });

  it.each<[string, string | null, string]>([
    ['no message', null, ''],
    ['exactly 30 characters', 'a'.repeat(30), 'a'.repeat(30)],
    ['31 characters', 'a'.repeat(31), `${'a'.repeat(29)}…`],
    ['an emoji at the cut', `${'a'.repeat(28)}😀😀😀`, `${'a'.repeat(28)}😀…`],
    ['a family emoji at the cut', `${'a'.repeat(29)}👨‍👩‍👧`, `${'a'.repeat(29)}👨‍👩‍👧`],
    ['line breaks', 'Do you have\n\n  dates?', 'Do you have dates?'],
    ['an email', 'mail a@b.co now', `mail ${MASKED} now`],
  ])('titles %s', (_label, text, title) => {
    expect(conversationTitle(text)).toBe(title);
  });

  it.each<[string, unknown]>([
    ['support', { kind: 'support' }],
    ['page:cart', { kind: 'page', page: 'cart' }],
    ['page:admin', null],
    ['product:not-an-id', null],
    [`product:${id<'Offer'>(1)}:x`, null],
    ['coupon:x', null],
  ])('reads the stored card ref %s', (ref, card) => {
    expect(storedCardOf(ref)).toEqual(card);
  });

  it('round-trips a cursor', () => {
    const cursor = { lastMessageAt: T0, id: conversationId(7) };
    expect(decodeCursor(encodeCursor(cursor))).toEqual({ ok: true, value: cursor });
    expect(decodeCursor(undefined)).toEqual({ ok: true, value: null });
  });
});
