import { parseId, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import { RecordingStepUp } from '../../src/modules/customers/application/testing/in-memory-account-deletion';
import { assertAccountDeletionAllowed } from '../../src/modules/customers/application/account-deletion-settings-flow';
import {
  InMemoryAddresses,
  ReversibleAddressCipher,
} from '../../src/modules/customers/application/testing/in-memory-address-book';
import { SetAccountDeletionSettings } from '../../src/modules/customers/application/use-cases/set-account-deletion-settings.use-case';
import { ViewAccountDeletionAvailability } from '../../src/modules/customers/application/use-cases/view-account-deletion-availability.use-case';
import { ViewAccountDeletionSettings } from '../../src/modules/customers/application/use-cases/view-account-deletion-settings.use-case';
import { CUSTOMERS_AUDIT_ACTIONS } from '../../src/modules/customers/domain/audit';
import { CUSTOMERS_EVENTS } from '../../src/modules/customers/domain/events';
import { ConfigAddressPolicy } from '../../src/modules/customers/infrastructure/config-address-policy';
import { PrismaAccountDeletionSettingsRepository } from '../../src/modules/customers/infrastructure/prisma-account-deletion-settings.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { ids } from './outbox-support';
import {
  createPersistence,
  marketOf,
  modelMap,
  otherMarketOf,
  type Persistence,
} from './persistence-support';
import { testDatabaseUrl } from './test-database';

// The account deletion setting history as the application role, in both Market fixtures: the
// real use cases on the real unit of work store every field and the reason and read them back,
// version by version, never across Markets; one audit row and one outbox row commit with each
// version and none with a refused one; the role can neither update nor delete a version; the
// CHECKs refuse what the API refuses.

const T0 = Temporal.Instant.from('2026-10-26T10:00:00Z');
const DENIED = '42501';
const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const CUSTOMER = id<'Account'>(0xc1);
const REASON = 'می‌خواهیم حذف حساب را فعال کنیم';

describe.each(TEST_MARKETS)('account deletion setting store in market %s (database)', (code) => {
  const market = marketOf(code);
  const other = marketOf(otherMarketOf(code));
  const clock = new FixedClock(T0);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let db: Persistence;
  let settings: PrismaAccountDeletionSettingsRepository;
  let audit: AuditWriter;
  let outbox: ReturnType<PrismaOutboxWriterFactory['forModule']>;
  let sql: Client;

  beforeAll(async () => {
    db = createPersistence();
    settings = new PrismaAccountDeletionSettingsRepository(db.service);
    const auditCatalogue = new AuditActionCatalogue();
    auditCatalogue.register('customers', CUSTOMERS_AUDIT_ACTIONS);
    auditCatalogue.seal();
    audit = PersistenceModule.auditWriterFor('customers').useFactory(
      auditCatalogue,
      ids,
      { now: () => Temporal.Now.instant() },
      NO_PERMISSION_KEYS,
    ) as AuditWriter;
    const eventCatalogue = new EventCatalogue();
    eventCatalogue.register('customers', CUSTOMERS_EVENTS);
    eventCatalogue.seal();
    outbox = new PrismaOutboxWriterFactory(
      modelMap,
      db.service,
      eventCatalogue,
      ids,
      NO_PERMISSION_KEYS,
    ).forModule('customers');
    sql = new Client({ connectionString: testDatabaseUrl() });
    await sql.connect();
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
  });

  const deps = () => ({
    unitOfWork: db.unitOfWork,
    addresses: new InMemoryAddresses(),
    cipher: new ReversibleAddressCipher(),
    policy: new ConfigAddressPolicy(markets),
    ids,
    clock,
    accountDeletionSettings: settings,
    audit,
    outbox,
    // The admin step-up is identity's (admin-step-up.db-spec.ts covers it): a proof of the admin
    // session is always there here, as in wallet-ledger.db-spec.ts.
    stepUp: new RecordingStepUp(clock.now()),
  });
  const auditRows = async (target: MarketContext) =>
    (
      await sql.query<{ after: { version: number } }>(
        `SELECT after FROM platform.audit_log
          WHERE market_id = $1 AND action = 'customers.account-deletion-settings.changed'
          ORDER BY (after->>'version')::int`,
        [target.marketId],
      )
    ).rows.map((row) => row.after.version);
  const events = async (target: MarketContext) =>
    (
      await sql.query<{ aggregate_version: number; payload: Record<string, unknown> }>(
        `SELECT aggregate_version, payload FROM customers.outbox
          WHERE market_id = $1 AND type = 'customers.account-deletion-settings-changed.v1'
          ORDER BY occurred_at, aggregate_version`,
        [target.marketId],
      )
    ).rows;
  const actor = (target: MarketContext, population: 'admin' | 'customer') =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population,
        accountId: population === 'admin' ? ADMIN : CUSTOMER,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      `deletion-db-abcd`,
    );
  const versionOf = async (target: MarketContext) => {
    const read = await new ViewAccountDeletionSettings(gate, deps()).execute(
      actor(target, 'admin'),
      {},
    );
    if (!read.ok) throw new Error(read.error.code);
    return read.value.version;
  };

  it('stores a version with its reason, an audit row and an event in one unit, in its own Market only', async () => {
    const otherBefore = await versionOf(other);
    const from = await versionOf(market);
    const auditedBefore = await auditRows(market);
    const eventsBefore = (await events(market)).length;
    const next = { enabled: true, waitingPeriodDays: 45 };

    const saved = await new SetAccountDeletionSettings(gate, deps()).execute(
      actor(market, 'admin'),
      { settings: next, expectedVersion: from, reason: REASON },
    );
    expect(saved).toEqual({ ok: true, value: { version: from + 1, settings: next } });

    const stored = await sql.query<{ reason: string; changed_by: string; waiting: number }>(
      `SELECT reason, changed_by, waiting_period_days AS waiting
         FROM customers.account_deletion_settings WHERE market_id = $1 AND version = $2`,
      [code, from + 1],
    );
    expect(stored.rows).toEqual([{ reason: REASON, changed_by: ADMIN, waiting: 45 }]);
    expect(await auditRows(market)).toEqual([...auditedBefore, from + 1]);
    const written = await events(market);
    expect(written).toHaveLength(eventsBefore + 1);
    expect(written.at(-1)).toMatchObject({
      aggregate_version: from + 1,
      payload: { enabled: true, waitingPeriodDays: 45 },
    });
    expect(JSON.stringify(written.at(-1))).not.toContain(REASON);

    const read = await new ViewAccountDeletionSettings(gate, deps()).execute(
      actor(market, 'admin'),
      {},
    );
    expect(read).toEqual({ ok: true, value: { version: from + 1, settings: next } });
    expect(await versionOf(other)).toBe(otherBefore);

    const stale = await new SetAccountDeletionSettings(gate, deps()).execute(
      actor(market, 'admin'),
      { settings: { ...next, waitingPeriodDays: 60 }, expectedVersion: from, reason: REASON },
    );
    expect(stale).toEqual({ ok: false, error: { code: 'customers.conflict' } });
    // The refused save wrote no audit row and no event.
    expect(await auditRows(market)).toEqual([...auditedBefore, from + 1]);
    expect(await events(market)).toHaveLength(eventsBefore + 1);
  });

  it('answers the customer and the guard from the stored setting', async () => {
    const from = await versionOf(market);
    await new SetAccountDeletionSettings(gate, deps()).execute(actor(market, 'admin'), {
      settings: { enabled: true, waitingPeriodDays: 14 },
      expectedVersion: from,
      reason: REASON,
    });
    const read = await new ViewAccountDeletionAvailability(gate, deps()).execute(
      actor(market, 'customer'),
      {},
    );
    expect(read).toEqual({ ok: true, value: { canDeleteAccount: true, waitingPeriodDays: 14 } });
    const guarded = await db.unitOfWork.run(
      market,
      async () => assertAccountDeletionAllowed(settings, market),
      { readOnly: true },
    );
    expect(guarded).toEqual({ ok: true, value: { waitingPeriodDays: 14 } });
  });

  it('keeps the history insert-only for the application role', async () => {
    await expect(
      sql.query(
        `UPDATE customers.account_deletion_settings SET enabled = false WHERE market_id = $1`,
        [code],
      ),
    ).rejects.toMatchObject({ code: DENIED });
    await expect(
      sql.query(`DELETE FROM customers.account_deletion_settings WHERE market_id = $1`, [code]),
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
        enabled: true,
        waiting_period_days: 30,
        reason: 'A reason',
        changed_at: new Date(T0.epochMilliseconds),
        changed_by: ADMIN,
        ...overrides,
      };
      const columns = Object.keys(row);
      return sql.query(
        `INSERT INTO customers.account_deletion_settings (${columns.map((c) => `"${c}"`).join(', ')})
         VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
        Object.values(row),
      );
    };

    it.each([
      ['a wait of 6 days', { waiting_period_days: 6 }],
      ['a wait of 91 days', { waiting_period_days: 91 }],
      ['an empty reason', { reason: '' }],
      ['an untrimmed reason', { reason: ' why' }],
      ['a reason with a control character', { reason: 'why\nnot' }],
      ['a reason with markup', { reason: '<b>why</b>' }],
      ['a reason with a bidi override', { reason: 'why ‮not' }],
      ['a reason with a zero-width space', { reason: 'why​not' }],
      ['a reason with a tag character', { reason: 'why\u{E0041}not' }],
      ['a reason with a Cf character outside the BMP', { reason: 'why\u{1D173}not' }],
      ['a reason with a line separator', { reason: 'why not' }],
      ['a reason of 501 characters', { reason: 'x'.repeat(501) }],
      ['version 0', { version: 0 }],
      ['a malformed Market', { market_id: 'au' }],
    ])('refuses %s', async (_label, overrides) => {
      // 23514 check_violation; 22001 string_data_right_truncation (the VARCHAR(500) column).
      const refused = await insert(overrides).then(
        () => null,
        (error: { code: string }) => error.code,
      );
      expect(['23514', '22001']).toContain(refused);
    });

    it('accepts the bounds, Persian with its zero-width non-joiner included', async () => {
      await expect(insert({ waiting_period_days: 7 })).resolves.toBeDefined();
      await expect(insert({ waiting_period_days: 90 })).resolves.toBeDefined();
      await expect(insert({ reason: 'می‌خواهیم' })).resolves.toBeDefined();
      await expect(insert({ reason: 'x'.repeat(500) })).resolves.toBeDefined();
    });
  });
});
