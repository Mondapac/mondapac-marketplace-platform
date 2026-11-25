import { unusedChangeTrail } from '../support/change-trail-fakes';
import { createHash } from 'node:crypto';
import { ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext } from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { AssistantSettingsRepository } from '../../src/modules/assistant/application/ports/assistant-settings.repository';
import {
  answer,
  FakeRuntime,
  FakeTools,
  MemoryLimits,
  SequenceGuestTokens,
  FakePreviewTokens,
  FixedQuickPrompts,
} from '../../src/modules/assistant/application/testing/assistant-fakes';
import { SendGuestMessage } from '../../src/modules/assistant/application/use-cases/send-guest-message.use-case';
import {
  DEFAULT_ASSISTANT_SETTINGS,
  type AssistantSettings,
} from '../../src/modules/assistant/domain/assistant-settings';
import { PrismaConversationRepository } from '../../src/modules/assistant/infrastructure/prisma-conversation.repository';
import { PrismaFeedbackRepository } from '../../src/modules/assistant/infrastructure/prisma-feedback.repository';
import { PrismaInsightsRepository } from '../../src/modules/assistant/infrastructure/prisma-insights.repository';
import { PrismaSpendRepository } from '../../src/modules/assistant/infrastructure/prisma-spend.repository';
import { RegistryMarketCalendar } from '../../src/modules/assistant/infrastructure/registry-market-calendar';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaSubjectKeyStore } from '../../src/platform/persistence/prisma-subject-key-store';
import { LocalKeyWrapper } from '../../src/platform/subject-keys/local-key-wrapper';
import { NodeSubjectKeyService } from '../../src/platform/subject-keys/node-subject-key-service';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  randomUUID,
  type Persistence,
} from './persistence-support';
import { ids } from './outbox-support';
import { ASSISTANT_EVENTS } from '../../src/modules/assistant/domain/events';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { testDatabaseUrl } from './test-database';
import { assistantUsageReport, settleBuyerChat, settlingRuntime } from './assistant-usage-report';
import { BUYER_CHAT } from '../../src/modules/assistant/contracts/ai-capabilities';

// The buyer assistant's conversations and spend as the application role, in both Market
// fixtures: message text is stored only as ciphertext under the conversation's own key and read
// back in order; the purge deletes expired conversations with their messages and destroys their
// keys; spend counts up per Market and day; the grants and CHECKs refuse what the code never does.
// One guest message runs end to end on the real unit of work with a fake model.

const T0 = Temporal.Instant.from('2026-10-19T21:00:00Z');
const CHECK = '23514';
const DENIED = '42501';
const DAY = 24;
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

class NoAudit implements AuditWriter {
  record() {
    return Promise.resolve();
  }
}

class OneSettings implements AssistantSettingsRepository {
  constructor(private readonly current: AssistantSettings) {}
  latest() {
    return Promise.resolve({ version: 1, settings: this.current, changedAt: T0 });
  }
  append() {
    return Promise.resolve(false);
  }
}

describe.each(TEST_MARKETS)('assistant conversations store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  let db: Persistence;
  let keys: NodeSubjectKeyService;
  let conversations: PrismaConversationRepository;
  let spend: PrismaSpendRepository;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    keys = new NodeSubjectKeyService(
      new PrismaSubjectKeyStore(db.service, db.unitOfWork),
      new LocalKeyWrapper({ nodeEnv: 'test', nodeEnvExplicit: true }),
      clock,
    );
    conversations = new PrismaConversationRepository(db.service, keys);
    spend = new PrismaSpendRepository(db.service, assistantUsageReport(db.service));
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await sql.end();
    await db.close();
  });

  const inUnit = async <T>(target: MarketContext, work: () => Promise<T>): Promise<T> => {
    const result = await db.unitOfWork.run(target, async () => ok(await work()));
    if (!result.ok) throw new Error('unreachable');
    return result.value;
  };
  const read = <T>(target: MarketContext, work: () => Promise<T>) => inUnit(target, work);

  /** A committed guest conversation with `retentionDays`, last written `at`. */
  async function guestConversation(retentionDays: 0 | 30, at = T0, target = market) {
    const conversationId: string = ids.next<'Conversation'>();
    const tokenHash = hashOf(randomUUID());
    await inUnit(target, () =>
      conversations.create(target, {
        id: conversationId,
        owner: { kind: 'guest', tokenHash },
        turns: 0,
        retentionDays,
        startedAt: at,
      }),
    );
    return { conversationId, tokenHash };
  }

  const message = (role: 'buyer' | 'assistant', text: string, at = T0) => ({
    role,
    text,
    cards: role === 'assistant' ? ['product:x'] : [],
    at,
  });

  it('keeps message text only as ciphertext and reads it back in order, in its own Market', async () => {
    const { conversationId, tokenHash } = await guestConversation(30);
    await inUnit(market, async () => {
      expect(await conversations.countTurn(market, conversationId, 0, T0)).toBe(true);
      await conversations.append(market, conversationId, message('buyer', 'dates for a gift?'));
      await conversations.append(market, conversationId, message('assistant', 'Try Medjool.'));
    });

    await expect(read(market, () => conversations.find(market, conversationId))).resolves.toEqual({
      id: conversationId,
      owner: { kind: 'guest', tokenHash },
      turns: 1,
      retentionDays: 30,
      startedAt: T0,
      lastMessageAt: T0,
    });
    await expect(read(other, () => conversations.find(other, conversationId))).resolves.toBeNull();
    await expect(
      read(market, () => conversations.history(market, conversationId, 12)),
    ).resolves.toEqual([
      { role: 'buyer', text: 'dates for a gift?' },
      { role: 'assistant', text: 'Try Medjool.' },
    ]);
    await expect(
      read(market, () => conversations.history(market, conversationId, 1)),
    ).resolves.toEqual([{ role: 'assistant', text: 'Try Medjool.' }]);
    const stored = await sql.query<{ text_cipher: string; position: number }>(
      'SELECT text_cipher, position FROM assistant.messages WHERE conversation_id = $1 ORDER BY position',
      [conversationId],
    );
    expect(stored.rows.map((row) => row.position)).toEqual([1, 2]);
    for (const row of stored.rows) {
      expect(row.text_cipher).not.toContain('gift');
      expect(row.text_cipher).not.toContain('Medjool');
    }
  });

  /** A committed conversation of `accountId` with one buyer message and one reply. */
  async function accountConversation(
    accountId: Id<'Account'>,
    firstText: string,
    at: Temporal.Instant,
    retentionDays: 0 | 30 | 365 = 365,
    target = market,
  ) {
    const conversationId: string = ids.next<'Conversation'>();
    await inUnit(target, async () => {
      await conversations.create(target, {
        id: conversationId,
        owner: { kind: 'account', accountId },
        turns: 0,
        retentionDays,
        startedAt: at,
      });
      await conversations.countTurn(target, conversationId, 0, at);
      if (retentionDays > 0) {
        await conversations.append(target, conversationId, message('buyer', firstText, at));
        await conversations.append(target, conversationId, {
          role: 'assistant',
          text: 'Here you go.',
          cards: [`product:${id<'Offer'>(0xd001)}`, 'support'],
          at,
        });
      }
    });
    return conversationId;
  }

  it("lists one account's conversations newest first, within the given windows, by keyset", async () => {
    const accountId = ids.next<'Account'>();
    const old = await accountConversation(accountId, 'old question', T0);
    const recent = await accountConversation(accountId, 'recent question', T0.add({ hours: 5 }));
    const thirty = await accountConversation(accountId, 'thirty', T0.add({ hours: 3 }), 30);
    await accountConversation(accountId, 'none', T0.add({ hours: 4 }), 0);
    await accountConversation(ids.next<'Account'>(), 'someone else', T0.add({ hours: 6 }));
    await accountConversation(accountId, 'other market', T0.add({ hours: 7 }), 365, other);
    const everything = new Map([
      [30, T0.subtract({ hours: 1 })],
      [365, T0.subtract({ hours: 1 })],
    ]);

    const { rows: all, next: none } = await read(market, () =>
      conversations.listByAccount(market, accountId, {
        visibleSince: everything,
        after: null,
        limit: 10,
      }),
    );
    expect(none).toBeNull();
    expect(all.map((row) => [row.id, row.firstBuyerText, row.turns])).toEqual([
      [recent, 'recent question', 1],
      [thirty, 'thirty', 1],
      [old, 'old question', 1],
    ]);

    const page = await read(market, () =>
      conversations.listByAccount(market, accountId, {
        visibleSince: everything,
        after: { lastMessageAt: all[0]!.lastMessageAt, id: all[0]!.id },
        limit: 1,
      }),
    );
    expect(page.rows.map((row) => row.id)).toEqual([thirty]);
    expect(page.next).toEqual({ lastMessageAt: all[1]!.lastMessageAt, id: thirty });

    // A conversation whose key is already destroyed (a purge or delete in flight) is left out
    // but still moves the page on, so the older ones stay reachable.
    await inUnit(market, () => keys.destroyKey(market, recent as Id<'Conversation'>));
    const skipped = await read(market, () =>
      conversations.listByAccount(market, accountId, {
        visibleSince: everything,
        after: null,
        limit: 1,
      }),
    );
    expect(skipped.rows).toEqual([]);
    expect(skipped.next).toEqual({ lastMessageAt: all[0]!.lastMessageAt, id: recent });

    // Only 365-day conversations whose last message is after T0 + 1h: the old one is out.
    const windowed = await read(market, () =>
      conversations.listByAccount(market, accountId, {
        visibleSince: new Map([[365, T0.add({ hours: 1 })]]),
        after: null,
        limit: 10,
      }),
    );
    expect(windowed.rows.map((row) => row.id)).toEqual([]);
    await expect(
      read(market, () =>
        conversations.listByAccount(market, accountId, {
          visibleSince: new Map(),
          after: null,
          limit: 10,
        }),
      ),
    ).resolves.toEqual({ rows: [], next: null });
  });

  it('pages ties on the last message time by id, newest first, as the index orders them', async () => {
    const accountId = ids.next<'Account'>();
    const at = T0.add({ hours: 9 });
    const made = [
      await accountConversation(accountId, 'one', at),
      await accountConversation(accountId, 'two', at),
      await accountConversation(accountId, 'three', at),
    ];
    const windows = new Map([[365, at]]);

    const seen: string[] = [];
    let after: { lastMessageAt: Temporal.Instant; id: string } | null = null;
    for (let page = 0; page < 4; page += 1) {
      const result = await read(market, () =>
        conversations.listByAccount(market, accountId, { visibleSince: windows, after, limit: 1 }),
      );
      seen.push(...result.rows.map((row) => row.id));
      after = result.next;
      if (after === null) break;
    }

    // The window edge is inclusive: `at` itself is listed.
    expect(seen).toEqual([...made].sort().reverse());
  });

  it('reads a whole transcript in order with its card refs and times', async () => {
    const accountId = ids.next<'Account'>();
    const conversationId = await accountConversation(accountId, 'dates?', T0);

    await expect(
      read(market, () => conversations.transcript(market, conversationId)),
    ).resolves.toEqual([
      { position: 1, role: 'buyer', text: 'dates?', cards: [], at: T0 },
      {
        position: 2,
        role: 'assistant',
        text: 'Here you go.',
        cards: [`product:${id<'Offer'>(0xd001)}`, 'support'],
        at: T0,
      },
    ]);
    await expect(
      read(other, () => conversations.transcript(other, conversationId)),
    ).resolves.toEqual([]);
  });

  it("deletes only the owner's conversation, with its messages and key, as the application role", async () => {
    const accountId = ids.next<'Account'>();
    const conversationId = await accountConversation(accountId, 'delete me', T0);
    const noText = await accountConversation(accountId, 'n/a', T0, 0);

    await expect(
      inUnit(market, () => conversations.deleteOwn(market, conversationId, ids.next<'Account'>())),
    ).resolves.toBe(false);
    await expect(
      inUnit(other, () => conversations.deleteOwn(other, conversationId, accountId)),
    ).resolves.toBe(false);
    await expect(
      inUnit(market, () => conversations.deleteOwn(market, conversationId, accountId)),
    ).resolves.toBe(true);
    await expect(
      inUnit(market, () => conversations.deleteOwn(market, noText, accountId)),
    ).resolves.toBe(true);

    await expect(
      read(market, () => conversations.find(market, conversationId)),
    ).resolves.toBeNull();
    const left = await sql.query('SELECT 1 FROM assistant.messages WHERE conversation_id = $1', [
      conversationId,
    ]);
    expect(left.rowCount).toBe(0);
    const encrypted = await read(market, () =>
      keys.encrypt(market, conversationId as Id<'Conversation'>, 'x' as never, 'y'),
    );
    expect(encrypted.ok).toBe(false);

    // The id is spent: a new conversation that keeps text is refused instead of failing its
    // key (which would roll back the spend of the turn); one that keeps none may reuse it.
    await expect(read(market, () => conversations.spent(market, conversationId))).resolves.toBe(
      true,
    );
    await expect(read(market, () => conversations.spent(market, noText))).resolves.toBe(false);
    await expect(
      inUnit(market, () =>
        conversations.create(market, {
          id: conversationId,
          owner: { kind: 'account', accountId },
          turns: 0,
          retentionDays: 30,
          startedAt: T0,
        }),
      ),
    ).resolves.toBe(false);
    await expect(
      read(market, () => conversations.find(market, conversationId)),
    ).resolves.toBeNull();
  });

  it('counts a turn only from the expected count (a concurrent message loses)', async () => {
    const { conversationId } = await guestConversation(0);
    await inUnit(market, async () => {
      expect(await conversations.countTurn(market, conversationId, 0, T0)).toBe(true);
      expect(await conversations.countTurn(market, conversationId, 0, T0)).toBe(false);
    });
    await inUnit(other, async () => {
      expect(await conversations.countTurn(other, conversationId, 1, T0)).toBe(false);
    });
  });

  it('refuses a second conversation with the same id, from any Market', async () => {
    const { conversationId } = await guestConversation(0);
    const again = (target: MarketContext) =>
      inUnit(target, () =>
        conversations.create(target, {
          id: conversationId,
          owner: { kind: 'account', accountId: id<'Account'>(0xc1) },
          turns: 0,
          retentionDays: 0,
          startedAt: T0,
        }),
      );
    await expect(again(market)).resolves.toBe(false);
    await expect(again(other)).resolves.toBe(false);
  });

  it('purges expired conversations with their messages and destroys their keys', async () => {
    const now = T0.add({ hours: 40 * DAY });
    const expired = await guestConversation(30, T0);
    const fresh = await guestConversation(30, now.subtract({ hours: 2 * DAY }));
    const otherMarket = await guestConversation(30, T0, other);
    await inUnit(market, () =>
      conversations.append(market, expired.conversationId, message('buyer', 'old')),
    );

    const purged = await inUnit(market, () =>
      conversations.purgeExpired(market, now, { customer: 365, guest: 30 }, 1000),
    );

    expect(purged).toBeGreaterThanOrEqual(1);
    await expect(
      read(market, () => conversations.find(market, expired.conversationId)),
    ).resolves.toBeNull();
    await expect(
      read(market, () => conversations.find(market, fresh.conversationId)),
    ).resolves.not.toBeNull();
    await expect(
      read(other, () => conversations.find(other, otherMarket.conversationId)),
    ).resolves.not.toBeNull();
    const left = await sql.query('SELECT 1 FROM assistant.messages WHERE conversation_id = $1', [
      expired.conversationId,
    ]);
    expect(left.rowCount).toBe(0);
    const encrypted = await read(market, () =>
      keys.encrypt(market, expired.conversationId as Id<'Conversation'>, 'x' as never, 'y'),
    );
    expect(encrypted.ok).toBe(false);
  });

  it('applies a shorter retention set since, to conversations already kept longer', async () => {
    const now = T0.add({ hours: 10 * DAY });
    const kept = await guestConversation(30, T0);
    await inUnit(market, () =>
      conversations.purgeExpired(market, now, { customer: 365, guest: 30 }, 1000),
    );
    await expect(
      read(market, () => conversations.find(market, kept.conversationId)),
    ).resolves.not.toBeNull();
    // The admin now keeps nothing: a day is the floor, so this one goes.
    await inUnit(market, () =>
      conversations.purgeExpired(market, now, { customer: 0, guest: 0 }, 1000),
    );
    await expect(
      read(market, () => conversations.find(market, kept.conversationId)),
    ).resolves.toBeNull();
  });

  it('reads the spend from the gateway, counts conversations and records one auto-off a day', async () => {
    // A day of its own per Market fixture: each run writes the other Market's row too.
    const day = Temporal.PlainDate.from(code === 'AU' ? '2031-03-14' : '2031-05-14');
    const next = day.add({ days: 1 });
    // The spend is what the gateway settled (G7b); the spend fields given to add are not counted.
    const turn = async (
      target: MarketContext,
      on: Temporal.PlainDate,
      microUsd: number,
      conversationsAdded: number,
    ) => {
      await settleBuyerChat(sql, target, on, microUsd);
      await inUnit(target, () =>
        spend.add(target, on, {
          microUsd,
          inputTokens: 10,
          outputTokens: 2,
          conversations: conversationsAdded,
        }),
      );
    };
    await turn(market, day, 1500, 1);
    await turn(market, day, 500, 0);
    await turn(market, next, 700, 1);
    await turn(other, day, 9_999, 3);

    // lastAutoOff is the Market's newest record of any day; it is checked after this day's below.
    const first = await read(market, () => spend.totals(market, day));
    expect({ ...first, lastAutoOff: null }).toEqual({
      todayMicroUsd: 2000,
      monthMicroUsd: 2000,
      conversationsToday: 1,
      lastAutoOff: null,
    });
    // An instant on that Market day (a record for a later day is refused).
    const at = Temporal.Instant.from(`${next.toString()}T12:00:00Z`);
    await expect(inUnit(market, () => spend.markAutoOff(market, next, 'daily', at))).resolves.toBe(
      true,
    );
    await expect(
      inUnit(market, () => spend.markAutoOff(market, next, 'monthly', at)),
    ).resolves.toBe(false);
    const totals = await read(market, () => spend.totals(market, next));
    expect({ ...totals, lastAutoOff: null }).toEqual({
      todayMicroUsd: 700,
      monthMicroUsd: 2700,
      conversationsToday: 1,
      lastAutoOff: null,
    });
    // Temporal instants compare by their text (toEqual sees no fields on them).
    expect([totals.lastAutoOff?.at.toString(), totals.lastAutoOff?.cap]).toEqual([
      at.toString(),
      'daily',
    ]);
    const old = await sql.query(
      'SELECT 1 FROM assistant.spend_days WHERE market_id = $1 AND day IN ($2, $3)',
      [market.marketId, day.toString(), next.toString()],
    );
    expect(old.rows).toEqual([]);
  });

  it('keeps the conversation count and the auto-off record in their new homes (G7)', async () => {
    const day = Temporal.PlainDate.from(code === 'AU' ? '2031-07-14' : '2031-09-14');
    const add = (target: MarketContext, conversationsAdded: number) =>
      inUnit(target, () =>
        spend.add(target, day, {
          microUsd: 100,
          inputTokens: 1,
          outputTokens: 1,
          conversations: conversationsAdded,
        }),
      );
    await add(market, 1);
    await add(market, 0);
    await add(market, 2);
    await add(other, 5);
    const counted = await sql.query<{ market_id: string; conversations: number }>(
      `SELECT market_id, conversations FROM assistant.conversation_days WHERE day = $1
        ORDER BY market_id`,
      [day.toString()],
    );
    expect(new Map(counted.rows.map((row) => [row.market_id, row.conversations]))).toEqual(
      new Map([
        [market.marketId, 3],
        [other.marketId, 5],
      ]),
    );

    const at = Temporal.Instant.from(`${day.toString()}T12:00:00Z`);
    await inUnit(market, () => spend.markAutoOff(market, day, 'monthly', at));
    await inUnit(market, () => spend.markAutoOff(market, day, 'daily', at.add({ minutes: 1 })));
    const reached = await sql.query<{ market_id: string; at: Date; period: string }>(
      `SELECT market_id, cap_reached_at AS at, cap_reached_period AS period
         FROM platform.ai_budget_counters
        WHERE period = 'day' AND period_start = $1 AND scope = 'capability' AND scope_key = $2
          AND cap_reached_at IS NOT NULL`,
      [day.toString(), BUYER_CHAT],
    );
    expect(reached.rows).toEqual([
      { market_id: market.marketId, at: new Date(at.epochMilliseconds), period: 'month' },
    ]);
    // Cross-Market canary (Hassan, PR 1354): the other Market reads neither the record nor the cost.
    const report = assistantUsageReport(db.service);
    await sql.query(
      `INSERT INTO platform.ai_usage_days (id, market_id, tenant_id, day, capability, seller_id,
         calls, cost_micro_usd) VALUES (gen_random_uuid(), $1, $2, $3, $4, NULL, 1, 4321)`,
      [market.marketId, market.tenantId, day.toString(), BUYER_CHAT],
    );
    // The other Market gets its own record back, never this one (Hassan, PR 1354 B).
    // Temporal instants compare by their text: toEqual sees no fields on them.
    // An old day, so this record is never the other Market's newest in the other tests.
    const otherDay = Temporal.PlainDate.from('2020-01-01');
    const otherAt = Temporal.Instant.from('2020-01-01T12:00:00Z');
    await inUnit(other, () => report.markCapReached(other, BUYER_CHAT, otherDay, 'day', otherAt));
    const others = await read(other, () => report.lastCapReached(other, BUYER_CHAT));
    const mine = await read(market, () => report.lastCapReached(market, BUYER_CHAT));
    expect(others?.at.toString()).not.toBe(at.toString());
    expect(others).not.toBeNull();
    expect(mine?.period).toBe('month');
    await expect(read(other, () => report.costByDay(other, BUYER_CHAT, day, day))).resolves.toEqual(
      [],
    );
    await expect(
      read(market, () => report.costByDay(market, BUYER_CHAT, day, day)),
    ).resolves.toEqual([{ day, costMicroUsd: 4321 }]);
    const cost = await read(market, () => report.costByDay(market, BUYER_CHAT, day, day));
    expect(cost.map((row) => row.day.toString())).toEqual([day.toString()]);
  });

  it('rolls the turn back when the gateway record cannot be written (fail closed)', async () => {
    const day = Temporal.PlainDate.from(code === 'AU' ? '2031-08-14' : '2031-10-14');
    const real = assistantUsageReport(db.service);
    const failing = new PrismaSpendRepository(db.service, {
      ...real,
      markCapReached: () => Promise.reject(new Error('gateway down')),
    });
    const at = Temporal.Instant.from(`${day.toString()}T12:00:00Z`);
    await expect(
      inUnit(market, async () => {
        await failing.add(market, day, {
          microUsd: 1,
          inputTokens: 1,
          outputTokens: 1,
          conversations: 1,
        });
        return failing.markAutoOff(market, day, 'daily', at);
      }),
    ).rejects.toThrow('gateway down');
    const row = await sql.query(
      'SELECT 1 FROM assistant.conversation_days WHERE market_id = $1 AND day = $2',
      [market.marketId, day.toString()],
    );
    expect(row.rows).toEqual([]);
  });

  const outboxWriter = () => {
    const catalogue = new EventCatalogue();
    catalogue.register('assistant', ASSISTANT_EVENTS);
    catalogue.seal();
    return new PrismaOutboxWriterFactory(
      modelMap,
      db.service,
      catalogue,
      ids,
      NO_PERMISSION_KEYS,
    ).forModule('assistant');
  };

  it('writes one spend-cap event in the unit of the turn that reached the cap', async () => {
    const fake = new FakeRuntime();
    fake.script.push(answer({ text: 'One.', costMicroUsd: 2_000_000 }));
    // The cost is settled in the gateway's day row before the answer, as the gateway does: the turn
    // that crosses the cap sees it in its own unit and records the event (Hassan, PR 1354 note 6).
    const calendar = new RegistryMarketCalendar(markets);
    // A day of its own, so the other tests' spend never reaches this cap first.
    const day = T0.add({ hours: 24 * 40 });
    const runtime = settlingRuntime(fake, sql, (target) => calendar.dayOf(target, day));
    const send = new SendGuestMessage(
      createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) }),
      {
        unitOfWork: db.unitOfWork,
        settings: new OneSettings({
          ...DEFAULT_ASSISTANT_SETTINGS,
          enabled: true,
          audience: 'all',
          dailySpendCapUsdCents: 100,
          monthlySpendCapUsdCents: 2_000_000,
        }),
        runtime,
        audit: new NoAudit(),
        clock: new FixedClock(day),
        conversations,
        feedback: new PrismaFeedbackRepository(db.service),
        insights: new PrismaInsightsRepository(db.service, keys, assistantUsageReport(db.service)),
        spend,
        tools: new FakeTools(),
        limits: new MemoryLimits(),
        guestTokens: new SequenceGuestTokens(),
        calendar: new RegistryMarketCalendar(markets),
        outbox: outboxWriter(),
        previewTokens: new FakePreviewTokens(),
        quickPrompts: new FixedQuickPrompts(),
        trail: unusedChangeTrail,
      },
    );
    const context = testCallContext(market, 'anonymous', 'assistant-db-cap-01');
    const message = () =>
      send.execute(context, {
        conversationId: ids.next<'Conversation'>(),
        text: 'Hi',
        visitor: undefined,
        token: null,
        origin: '203.0.113.9',
      });
    expect((await message()).ok).toBe(true);
    expect(await message()).toEqual({ ok: false, error: { code: 'assistant.paused' } });

    const rows = await sql.query<{ type: string; payload: unknown; aggregate_version: number }>(
      `SELECT type, payload, aggregate_version FROM assistant.outbox
        WHERE market_id = $1 AND correlation_id = 'assistant-db-cap-01'`,
      [market.marketId],
    );
    expect(rows.rows).toEqual([
      { type: 'assistant.spend-cap-reached.v1', payload: { cap: 'daily' }, aggregate_version: 1 },
    ]);
  });

  it("answers a guest end to end on the real unit of work, keeping the buyer's text masked", async () => {
    const fake = new FakeRuntime();
    fake.script.push(answer({ text: 'Happy to help with dates.', costMicroUsd: 1234 }));
    const runtime = settlingRuntime(fake, sql, (target) =>
      new RegistryMarketCalendar(markets).dayOf(target, clock.now()),
    );
    const send = new SendGuestMessage(
      createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) }),
      {
        unitOfWork: db.unitOfWork,
        settings: new OneSettings({
          ...DEFAULT_ASSISTANT_SETTINGS,
          enabled: true,
          audience: 'all',
        }),
        runtime,
        audit: new NoAudit(),
        clock,
        conversations,
        feedback: new PrismaFeedbackRepository(db.service),
        insights: new PrismaInsightsRepository(db.service, keys, assistantUsageReport(db.service)),
        spend,
        tools: new FakeTools(),
        limits: new MemoryLimits(),
        guestTokens: new SequenceGuestTokens(),
        calendar: new RegistryMarketCalendar(markets),
        outbox: outboxWriter(),
        quickPrompts: new FixedQuickPrompts(),
        previewTokens: new FakePreviewTokens(),
        trail: unusedChangeTrail,
      },
    );
    const conversationId: string = ids.next<'Conversation'>();
    const context = testCallContext(market, 'anonymous', 'assistant-db-0001');
    const before = await read(market, () =>
      spend.totals(market, new RegistryMarketCalendar(markets).dayOf(market, T0)),
    );

    const sent = await send.execute(context, {
      conversationId,
      text: 'dates? mail me at me@example.com',
      visitor: undefined,
      token: null,
      origin: '203.0.113.7',
    });

    expect(sent.ok).toBe(true);
    if (!sent.ok) return;
    expect(sent.value.sentences).toEqual(['Happy to help with dates.']);
    expect(sent.value.guestToken).not.toBeNull();
    await expect(
      read(market, () => conversations.history(market, conversationId, 12)),
    ).resolves.toEqual([
      { role: 'buyer', text: 'dates? mail me at [masked]' },
      { role: 'assistant', text: 'Happy to help with dates.' },
    ]);
    const after = await read(market, () =>
      spend.totals(market, new RegistryMarketCalendar(markets).dayOf(market, T0)),
    );
    expect(after.todayMicroUsd - before.todayMicroUsd).toBe(1234);
    expect(after.conversationsToday - before.conversationsToday).toBe(1);
  });

  describe('grants and CHECKs (application role)', () => {
    const insertConversation = (overrides: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = {
        id: ids.next<'Conversation'>(),
        market_id: market.marketId,
        tenant_id: market.tenantId,
        account_id: null,
        guest_token_hash: Buffer.alloc(32, 1),
        turns: 0,
        retention_days: 30,
        started_at: '2026-10-19T21:00:00Z',
        last_message_at: '2026-10-19T21:00:00Z',
        ...overrides,
      };
      const columns = Object.keys(row);
      return sql.query(
        `INSERT INTO assistant.conversations (${columns.join(', ')})
         VALUES (${columns.map((_c, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };
    const failure = (promise: Promise<unknown>) =>
      promise.then(
        () => null,
        (error: { code?: string }) => error.code,
      );

    it('accepts a valid guest conversation', async () => {
      await expect(insertConversation()).resolves.toBeDefined();
    });

    it.each([
      ['no owner', { guest_token_hash: null }],
      ['two owners', { account_id: id<'Account'>(0xc2) }],
      ['a short token hash', { guest_token_hash: Buffer.alloc(16, 1) }],
      ['31 turns', { turns: 31 }],
      ['a guest kept a year', { retention_days: 365 }],
      ['an unknown retention', { retention_days: 7 }],
      ['a last message before the start', { last_message_at: '2026-10-18T21:00:00Z' }],
    ])('refuses %s', async (_name, overrides) => {
      await expect(failure(insertConversation(overrides))).resolves.toBe(CHECK);
    });

    it('cannot change or delete what it never changes or deletes', async () => {
      await expect(failure(sql.query('UPDATE assistant.messages SET role = role'))).resolves.toBe(
        DENIED,
      );
      await expect(failure(sql.query('DELETE FROM assistant.spend_days'))).resolves.toBe(DENIED);
      await expect(failure(sql.query('DELETE FROM assistant.messages'))).resolves.toBe(DENIED);
      await expect(
        failure(sql.query('UPDATE assistant.conversations SET retention_days = retention_days')),
      ).resolves.toBe(DENIED);
      await expect(
        failure(sql.query('UPDATE assistant.conversations SET account_id = account_id')),
      ).resolves.toBe(DENIED);
    });

    it('accepts the assistant message class in the shared rate-limit counters, and no other', async () => {
      const insert = (key: string) =>
        sql.query(
          'INSERT INTO platform.rate_limit_counters (key, points, expire) VALUES ($1, 1, 1)',
          [key],
        );
      await expect(insert(`assistant-message:${hashOf(randomUUID())}`)).resolves.toBeDefined();
      await expect(failure(insert(`assistant-other:${hashOf(randomUUID())}`))).resolves.toBe(CHECK);
    });
  });
});
