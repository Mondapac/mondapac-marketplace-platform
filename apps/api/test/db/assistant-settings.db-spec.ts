import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import {
  FakeRuntime,
  FakeTools,
  MemoryConversations,
  MemoryLimits,
  SequenceGuestTokens,
} from '../../src/modules/assistant/application/testing/assistant-fakes';
import { SetAssistantSettings } from '../../src/modules/assistant/application/use-cases/set-assistant-settings.use-case';
import { ViewAssistantSettings } from '../../src/modules/assistant/application/use-cases/view-assistant-settings.use-case';
import { ViewStorefrontAssistant } from '../../src/modules/assistant/application/use-cases/view-storefront-assistant.use-case';
import { DEFAULT_ASSISTANT_SETTINGS } from '../../src/modules/assistant/domain/assistant-settings';
import { ASSISTANT_AUDIT_ACTIONS } from '../../src/modules/assistant/domain/audit';
import { PrismaAssistantSettingsRepository } from '../../src/modules/assistant/infrastructure/prisma-assistant-settings.repository';
import { PrismaSpendRepository } from '../../src/modules/assistant/infrastructure/prisma-spend.repository';
import { RegistryMarketCalendar } from '../../src/modules/assistant/infrastructure/registry-market-calendar';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import {
  createPersistence,
  marketOf,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { ids } from './outbox-support';
import { testDatabaseUrl } from './test-database';

// The assistant settings history as the application role, in both Market fixtures: the real use
// cases on the real unit of work store every field and read them back, version by version, never
// across Markets; the role can neither update nor delete a version; the CHECKs refuse what the
// API refuses.

const T0 = Temporal.Instant.from('2026-10-19T21:00:00Z');
const CHECK = '23514';
const DENIED = '42501';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);

const runtime = new FakeRuntime();

describe.each(TEST_MARKETS)('assistant settings store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let settings: PrismaAssistantSettingsRepository;
  let spend: PrismaSpendRepository;
  let audit: AuditWriter;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    settings = new PrismaAssistantSettingsRepository(db.service);
    spend = new PrismaSpendRepository(db.service);
    // The real audit writer (Hassan, package 2 review): the audit row commits with the version.
    const catalogue = new AuditActionCatalogue();
    catalogue.register('assistant', ASSISTANT_AUDIT_ACTIONS);
    catalogue.seal();
    audit = PersistenceModule.auditWriterFor('assistant').useFactory(
      catalogue,
      ids,
      { now: () => Temporal.Now.instant() },
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const deps = () => ({
    unitOfWork: db.unitOfWork,
    settings,
    runtime,
    audit,
    clock,
    conversations: new MemoryConversations(),
    spend,
    tools: new FakeTools(),
    limits: new MemoryLimits(),
    guestTokens: new SequenceGuestTokens(),
    calendar: new RegistryMarketCalendar(markets),
  });
  const auditRows = async (target: MarketContext) =>
    (
      await sql.query<{ after: { version: number } }>(
        `SELECT after FROM platform.audit_log
          WHERE market_id = $1 AND action = 'assistant.settings.changed'`,
        [target.marketId],
      )
    ).rows.map((row) => row.after.version);
  const admin = (target: MarketContext) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'assistant-db-abcd',
    );
  const versionOf = async (target: MarketContext) => {
    const read = await new ViewAssistantSettings(gate, deps()).execute(admin(target), {});
    if (!read.ok) throw new Error(read.error.code);
    return read.value.version;
  };

  it('stores every field as a new version and reads it back, in its own Market only', async () => {
    const otherBefore = await versionOf(other);
    const from = await versionOf(market);
    const next = {
      ...DEFAULT_ASSISTANT_SETTINGS,
      enabled: true,
      audience: 'percent' as const,
      audiencePercent: 25,
      modelTier: 'balanced' as const,
      users: 'customers-only' as const,
      guestMessageLimit: 60,
      customerMessageLimit: 120,
      retention: '12-months' as const,
      replyLanguage: 'english' as const,
      dailySpendCapUsdCents: 2_500,
      monthlySpendCapUsdCents: 50_000,
      welcomeText: 'سلام! می‌توانم کمک کنم؟',
    };
    const auditedBefore = await auditRows(market);
    const saved = await new SetAssistantSettings(gate, deps()).execute(admin(market), {
      settings: next,
      expectedVersion: from,
    });
    expect(saved.ok && saved.value.version).toBe(from + 1);
    // One audit row per version, written in the same unit as the version.
    expect(await auditRows(market)).toEqual([...auditedBefore, from + 1]);

    const read = await new ViewAssistantSettings(gate, deps()).execute(admin(market), {});
    expect(read.ok && read.value).toMatchObject({ version: from + 1, settings: next });
    expect(await versionOf(other)).toBe(otherBefore);

    const stale = await new SetAssistantSettings(gate, deps()).execute(admin(market), {
      settings: { ...next, guestMessageLimit: 30 },
      expectedVersion: from,
    });
    expect(stale).toEqual({ ok: false, error: { code: 'assistant.conflict' } });
    // The refused save wrote no audit row.
    expect(await auditRows(market)).toEqual([...auditedBefore, from + 1]);
  });

  it('reads the storefront subset through the real unit of work', async () => {
    const from = await versionOf(market);
    await new SetAssistantSettings(gate, deps()).execute(admin(market), {
      settings: {
        ...DEFAULT_ASSISTANT_SETTINGS,
        enabled: true,
        audience: 'all',
        welcomeText: 'Hi',
      },
      expectedVersion: from,
    });
    const read = await new ViewStorefrontAssistant(gate, deps()).execute(
      testCallContext(market, 'anonymous'),
      { visitor: null },
    );
    expect(read).toEqual({
      ok: true,
      value: { enabled: true, guestsAllowed: true, replyLanguage: 'buyer', welcomeText: 'Hi' },
    });
  });

  it('keeps the history insert-only for the application role', async () => {
    await expect(
      sql.query(`UPDATE assistant.settings SET enabled = false WHERE market_id = $1`, [code]),
    ).rejects.toMatchObject({ code: DENIED });
    await expect(
      sql.query(`DELETE FROM assistant.settings WHERE market_id = $1`, [code]),
    ).rejects.toMatchObject({ code: DENIED });
  });

  describe('the CHECKs', () => {
    // Rows of an unused Market code, so no use case above ever reads them.
    let version = 0;
    const insert = (overrides: Record<string, unknown>) => {
      version += 1;
      const row: Record<string, unknown> = {
        market_id: `Q${code}`,
        version,
        tenant_id: market.tenantId,
        enabled: false,
        audience: 'internal',
        audience_percent: null,
        scope: 'read-only',
        model_tier: 'fast',
        users: 'guests-and-customers',
        guest_message_limit: 20,
        customer_message_limit: 40,
        retention: '30-days',
        reply_language: 'buyer',
        daily_spend_cap_usd_cents: 1000,
        monthly_spend_cap_usd_cents: 20000,
        support_handoff: 'email-link',
        welcome_text: null,
        changed_at: new Date(T0.epochMilliseconds),
        changed_by: ADMIN,
        ...overrides,
      };
      const columns = Object.keys(row);
      return sql.query(
        `INSERT INTO assistant.settings (${columns.map((c) => `"${c}"`).join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it.each([
      ['an internal audience with a percentage', { audience_percent: 10 }],
      ['a percentage audience without one', { audience: 'percent' }],
      ['a percentage of 0', { audience: 'percent', audience_percent: 0 }],
      ['a percentage of 101', { audience: 'percent', audience_percent: 101 }],
      ['an unknown scope', { scope: 'everything' }],
      ['an unknown model tier', { model_tier: 'model-fast' }],
      ['an unknown user group', { users: 'guests' }],
      ['a guest limit of 4', { guest_message_limit: 4 }],
      ['a guest limit of 61', { guest_message_limit: 61 }],
      ['a customer limit of 121', { customer_message_limit: 121 }],
      ['an unknown retention', { retention: '7-days' }],
      ['an unknown language', { reply_language: 'fa' }],
      ['a daily cap of 99', { daily_spend_cap_usd_cents: 99 }],
      ['a daily cap above the monthly', { daily_spend_cap_usd_cents: 30000 }],
      ['an unknown hand-off', { support_handoff: 'phone' }],
      ['an empty welcome text', { welcome_text: '' }],
      ['an untrimmed welcome text', { welcome_text: ' Hi' }],
      ['a welcome text with a control character', { welcome_text: 'Hi\nthere' }],
      ['a welcome text with markup', { welcome_text: '<b>Hi</b>' }],
      ['a welcome text with a bidi override', { welcome_text: 'Hi \u202Eereht' }],
      ['a welcome text with a direction mark', { welcome_text: 'Hi\u200Fthere' }],
      ['a welcome text with a zero-width space', { welcome_text: 'Hi\u200Bthere' }],
      ['a welcome text with a line separator', { welcome_text: 'Hi\u2028there' }],
      ['version 0', { version: 0 }],
    ])('refuses %s', async (_label, overrides) => {
      await expect(insert(overrides)).rejects.toMatchObject({ code: CHECK });
    });

    it('accepts a valid row, Persian with its zero-width non-joiner included', async () => {
      await expect(insert({})).resolves.toBeDefined();
      await expect(insert({ welcome_text: 'می\u200Cتوانم کمک کنم؟' })).resolves.toBeDefined();
    });
  });
});
