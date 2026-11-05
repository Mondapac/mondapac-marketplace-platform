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
} from '../../src/modules/assistant/application/testing/assistant-fakes';
import { SendGuestMessage } from '../../src/modules/assistant/application/use-cases/send-guest-message.use-case';
import {
  DEFAULT_ASSISTANT_SETTINGS,
  type AssistantSettings,
} from '../../src/modules/assistant/domain/assistant-settings';
import { PrismaConversationRepository } from '../../src/modules/assistant/infrastructure/prisma-conversation.repository';
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
  otherMarketOf,
  randomUUID,
  type Persistence,
} from './persistence-support';
import { ids } from './outbox-support';
import { testDatabaseUrl } from './test-database';

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
    spend = new PrismaSpendRepository(db.service);
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

  it('counts spend up per Market and day and records one auto-off per day', async () => {
    // A day of its own per Market fixture: each run writes the other Market's row too.
    const day = Temporal.PlainDate.from(code === 'AU' ? '2031-03-14' : '2031-05-14');
    const next = day.add({ days: 1 });
    const add = (
      target: MarketContext,
      on: Temporal.PlainDate,
      microUsd: number,
      conversationsAdded: number,
    ) =>
      inUnit(target, () =>
        spend.add(target, on, {
          microUsd,
          inputTokens: 10,
          outputTokens: 2,
          conversations: conversationsAdded,
        }),
      );
    await add(market, day, 1500, 1);
    await add(market, day, 500, 0);
    await add(market, next, 700, 1);
    await add(other, day, 9_999, 3);

    await expect(read(market, () => spend.totals(market, day))).resolves.toEqual({
      todayMicroUsd: 2000,
      monthMicroUsd: 2000,
      conversationsToday: 1,
      lastAutoOff: null,
    });
    const at = T0.add({ hours: 1 });
    await expect(inUnit(market, () => spend.markAutoOff(market, next, 'daily', at))).resolves.toBe(
      true,
    );
    await expect(
      inUnit(market, () => spend.markAutoOff(market, next, 'monthly', at)),
    ).resolves.toBe(false);
    await expect(read(market, () => spend.totals(market, next))).resolves.toEqual({
      todayMicroUsd: 700,
      monthMicroUsd: 2700,
      conversationsToday: 1,
      lastAutoOff: { at, cap: 'daily' },
    });
  });

  it("answers a guest end to end on the real unit of work, keeping the buyer's text masked", async () => {
    const runtime = new FakeRuntime();
    runtime.script.push(answer({ text: 'Happy to help with dates.', costMicroUsd: 1234 }));
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
        spend,
        tools: new FakeTools(),
        limits: new MemoryLimits(),
        guestTokens: new SequenceGuestTokens(),
        calendar: new RegistryMarketCalendar(markets),
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
