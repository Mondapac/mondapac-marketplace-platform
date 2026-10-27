import { Temporal, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, MarketContext } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { AccountDeletionDependencies } from '../../src/modules/customers/application/account-deletion-dependencies';
import { assertAccountDeletionAllowed } from '../../src/modules/customers/application/account-deletion-settings-flow';
import { RecordingStepUp } from '../../src/modules/customers/application/testing/in-memory-account-deletion';
import {
  InMemoryAddresses,
  ReversibleAddressCipher,
} from '../../src/modules/customers/application/testing/in-memory-address-book';
import { CancelAccountDeletion } from '../../src/modules/customers/application/use-cases/cancel-account-deletion.use-case';
import { ExecuteAccountDeletions } from '../../src/modules/customers/application/use-cases/execute-account-deletions.use-case';
import { RequestAccountDeletion } from '../../src/modules/customers/application/use-cases/request-account-deletion.use-case';
import { SetAccountDeletionSettings } from '../../src/modules/customers/application/use-cases/set-account-deletion-settings.use-case';
import { ViewAccountDeletionAvailability } from '../../src/modules/customers/application/use-cases/view-account-deletion-availability.use-case';
import { ViewAccountDeletionSettings } from '../../src/modules/customers/application/use-cases/view-account-deletion-settings.use-case';
import { CUSTOMERS_AUDIT_ACTIONS } from '../../src/modules/customers/domain/audit';
import { CUSTOMERS_EVENTS } from '../../src/modules/customers/domain/events';
import { ConfigAddressPolicy } from '../../src/modules/customers/infrastructure/config-address-policy';
import { PrismaAccountDeletionRequestRepository } from '../../src/modules/customers/infrastructure/prisma-account-deletion-request.repository';
import { PrismaAccountDeletionSettingsRepository } from '../../src/modules/customers/infrastructure/prisma-account-deletion-settings.repository';
import { PrismaAddressRepository } from '../../src/modules/customers/infrastructure/prisma-address.repository';
import { AuditActionCatalogue } from '../../src/platform/audit/audit-action-catalogue';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { EventCatalogue } from '../../src/platform/events/event-catalogue';
import { NO_PERMISSION_KEYS } from '../../src/platform/events/outbox-writer';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { PrismaOutboxWriterFactory } from '../../src/platform/persistence/outbox/prisma-outbox-writer';
import { PersistenceModule } from '../../src/platform/persistence/persistence.module';
import { TEST_MARKETS, TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../support/test-config';
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

// The buyer deletion flow on the real stores as the application role, in both Market fixtures:
// the request, the one pending request per account (partial unique index, also under a race), the
// cancel, the executor deleting the address rows and closing the request, the grants; a request
// racing an admin switch-off is refused or ordered before it; two setting changes from the same
// version leave one winner and one customers.conflict. The facades of other modules are fakes
// that answer "nothing open"; their own specs cover them.

const UNIQUE = '23505';
let counter = 0;
const SEALED = `v1.${'A'.repeat(48)}`;

describe.each(TEST_MARKETS)(
  'buyer account deletion flow stores in market %s (database)',
  (code) => {
    const market = marketOf(code);
    const clock = new FixedClock(T0);
    const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
    let db: Persistence;
    let audit: AuditWriter;
    let outbox: ReturnType<PrismaOutboxWriterFactory['forModule']>;
    let sql: Client;
    let addresses: PrismaAddressRepository;
    let ended = 0;
    let erased: string[] = [];
    let BUYER: Id<'Account'>;
    let OTHER_BUYER: Id<'Account'>;

    beforeAll(async () => {
      db = createPersistence();
      addresses = new PrismaAddressRepository(db.service);
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

    const settingsRepo = () => new PrismaAccountDeletionSettingsRepository(db.service);
    const deps = (): AccountDeletionDependencies => {
      const zero = { amount: 0n, currency: 'AUD' };
      return {
        unitOfWork: db.unitOfWork,
        requests: new PrismaAccountDeletionRequestRepository(db.service),
        addresses,
        accountDeletionSettings: settingsRepo(),
        ids,
        clock,
        audit,
        outbox,
        identity: {
          endOtherCustomerSessions: () => {
            ended += 1;
            return Promise.resolve(ok({ revokedSessions: 0 }));
          },
          eraseCustomerAccount: (_c: CallContext, accountId: Id<'Account'>) => {
            erased.push(accountId);
            return Promise.resolve(ok({ code: 'erased' as const }));
          },
        },
        wallet: {
          ownBalanceOf: () => Promise.resolve(ok({ available: zero, held: zero })),
          balanceOf: () => Promise.resolve(ok({ available: zero, held: zero })),
        },
        ordering: {
          ownOpenObligations: () => Promise.resolve(ok({ openOrders: 0, pendingRefunds: 0 })),
          openObligationsOf: () => Promise.resolve(ok({ openOrders: 0, pendingRefunds: 0 })),
        },
        reviews: {
          detachAuthor: () => Promise.resolve(ok({ reviews: 0, ratings: 0 })),
        },
        engagement: {
          forgetAccount: () => Promise.resolve(ok({ events: 0 })),
        },
      };
    };
    const settingsDeps = () => ({
      unitOfWork: db.unitOfWork,
      addresses,
      cipher: undefined as never,
      policy: undefined as never,
      ids,
      clock,
      accountDeletionSettings: settingsRepo(),
      audit,
      outbox,
      stepUp: new RecordingStepUp(clock.now()),
    });
    const actor = (
      target: MarketContext,
      accountId: Id<'Account'>,
      population: 'admin' | 'customer',
    ) =>
      testCallContext(
        target,
        testAuthenticatedActor(target, {
          population,
          accountId,
          sessionId: id<'Session'>(0x61),
          sellerId: null,
        }),
        'deletion-flow-db-abcd',
      );
    const buyer = (accountId = BUYER) => actor(market, accountId, 'customer');
    const admin = () => actor(market, ADMIN, 'admin');
    const system = () => testCallContext(market, 'system', 'deletion-flow-db-sys1');

    const currentVersion = async () => {
      const read = await new ViewAccountDeletionSettings(gate, settingsDeps()).execute(admin(), {});
      if (!read.ok) throw new Error(read.error.code);
      return read.value.version;
    };
    const change = (enabled: boolean, expectedVersion: number, days = 14) =>
      new SetAccountDeletionSettings(gate, settingsDeps()).execute(admin(), {
        settings: { enabled, waitingPeriodDays: days },
        expectedVersion,
        reason: 'db spec',
      });
    /** Applies the value from whatever version is current, retrying a lost race. */
    const setTo = async (enabled: boolean, days = 14) => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const result = await change(enabled, await currentVersion(), days);
        if (result.ok) return;
        if (result.error.code !== 'customers.conflict') throw new Error(result.error.code);
      }
      throw new Error('could not change the setting');
    };
    // The executor's clock: after every request of these tests is due (the longest wait is 14 days).
    const later = () => new FixedClock(T0.add({ hours: 15 * 24 }));
    const ask = (accountId = BUYER) =>
      new RequestAccountDeletion(gate, deps()).execute(buyer(accountId), { confirm: true });
    const rows = async (accountId: Id<'Account'>) =>
      (
        await sql.query<{ id: string; status: string; days: number; cancel_reason: string | null }>(
          `SELECT id, status, waiting_period_days AS days, cancel_reason
           FROM customers.account_deletion_requests
          WHERE market_id = $1 AND account_id = $2 ORDER BY requested_at, id`,
          [code, accountId],
        )
      ).rows;
    beforeEach(async () => {
      ended = 0;
      erased = [];
      counter += 1;
      BUYER = id<'Account'>(0xe000 + counter * 2);
      OTHER_BUYER = id<'Account'>(0xe000 + counter * 2 + 1);
      await setTo(true, 14);
    });

    it('stores a pending request at now plus the period with an audit row and an event', async () => {
      const made = await ask();
      expect(made.ok).toBe(true);
      const [row] = await rows(BUYER);
      expect(row).toMatchObject({ status: 'pending', days: 14 });
      expect(ended).toBe(1);
      const audited = await sql.query(
        `SELECT 1 FROM platform.audit_log WHERE market_id = $1 AND action = $2 AND target_id = $3`,
        [code, 'customers.account-deletion.requested', row!.id],
      );
      expect(audited.rowCount).toBe(1);
      const event = await sql.query<{ payload: Record<string, unknown> }>(
        `SELECT payload FROM customers.outbox WHERE market_id = $1 AND aggregate_id = $2`,
        [code, row!.id],
      );
      expect(event.rows.map((r) => Object.keys(r.payload).sort())).toEqual([
        ['scheduledFor', 'waitingPeriodDays'],
      ]);
      const scheduled = await sql.query<{ ok: boolean }>(
        `SELECT scheduled_for = requested_at + interval '14 days' AS ok
         FROM customers.account_deletion_requests WHERE id = $1`,
        [row!.id],
      );
      expect(scheduled.rows[0]?.ok).toBe(true);
    });

    it('keeps one pending request per account, also when two requests race', async () => {
      const results = await Promise.all([ask(), ask(), ask()]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      for (const refused of results.filter((r) => !r.ok)) {
        expect(['customers.account-deletion-already-requested', 'customers.conflict']).toContain(
          refused.ok ? '' : refused.error.code,
        );
      }
      expect((await rows(BUYER)).filter((r) => r.status === 'pending')).toHaveLength(1);
      await expect(
        sql.query(
          `INSERT INTO customers.account_deletion_requests
           (id, market_id, tenant_id, account_id, status, waiting_period_days, requested_at, scheduled_for)
         VALUES ($1, $2, 'default', $3, 'pending', 14, now(), now() + interval '14 days')`,
          [ids.next(), code, BUYER],
        ),
      ).rejects.toMatchObject({ code: UNIQUE });
    });

    it('cancels, then lets the buyer ask again', async () => {
      await ask();
      const cancelled = await new CancelAccountDeletion(gate, deps()).execute(buyer(), {
        reason: 'sign-in',
      });
      expect(cancelled).toEqual({ ok: true, value: { code: 'cancelled' } });
      expect(await rows(BUYER)).toMatchObject([{ status: 'cancelled', cancel_reason: 'sign-in' }]);
      expect((await ask()).ok).toBe(true);
      expect((await rows(BUYER)).map((r) => r.status)).toEqual(['cancelled', 'pending']);
    });

    it('keeps a pending request when the setting is switched off, and still runs it', async () => {
      await ask();
      await setTo(false);
      expect((await rows(BUYER)).map((r) => r.status)).toEqual(['pending']);
      const refused = await ask(OTHER_BUYER);
      expect(refused).toEqual({
        ok: false,
        error: { code: 'customers.account-deletion-disabled' },
      });
      const executor = new ExecuteAccountDeletions(gate, { ...deps(), clock: later() });
      expect((await executor.execute(system(), {})).ok).toBe(true);
      expect(erased).toContain(BUYER);
      expect((await rows(BUYER)).map((r) => r.status)).toEqual(['completed']);
    });

    it('the executor deletes the address rows of the account only and closes the request once', async () => {
      await ask();
      for (const [n, owner] of [
        [1, BUYER],
        [2, BUYER],
        [3, OTHER_BUYER],
      ] as const) {
        await db.unitOfWork.run(market, async () => {
          await addresses.insert(market, {
            id: id<'CustomerAddress'>(0xa100 + counter * 10 + n),
            accountId: owner,
            sealed: SEALED,
            countryCode: 'AU',
            isDefault: false,
            createdAt: T0,
            updatedAt: T0,
          });
          return ok(undefined);
        });
      }
      const executor = new ExecuteAccountDeletions(gate, { ...deps(), clock: later() });
      // Requests of earlier tests are due too (the batch is 25): run until this one is closed.
      for (let run = 0; run < 20; run += 1) {
        await executor.execute(system(), {});
        if ((await rows(BUYER))[0]?.status === 'completed') break;
      }
      await executor.execute(system(), {});
      const left = await sql.query<{ account_id: string }>(
        `SELECT account_id FROM customers.addresses WHERE market_id = $1`,
        [code],
      );
      expect(left.rows).toEqual([{ account_id: OTHER_BUYER }]);
      expect((await rows(BUYER)).map((r) => r.status)).toEqual(['completed']);
      expect(await rows(OTHER_BUYER)).toEqual([]);
      const completed = await sql.query(
        `SELECT 1 FROM customers.outbox
        WHERE market_id = $1 AND type = 'customers.account-deletion-completed.v1'
          AND aggregate_id = $2`,
        [code, (await rows(BUYER))[0]!.id],
      );
      expect(completed.rowCount).toBe(1);
    });

    it('refuses or orders a request that races an admin switch-off, and refuses every later one', async () => {
      for (let round = 0; round < 5; round += 1) {
        await setTo(true, 14);
        const version = await currentVersion();
        BUYER = id<'Account'>(0xf000 + counter * 10 + round);
        OTHER_BUYER = id<'Account'>(0xf800 + counter * 10 + round);
        const [asked, switched] = await Promise.all([ask(), change(false, version)]);
        // The request either saw deletion on (ordered before the switch) or was refused.
        if (!asked.ok) {
          expect(['customers.account-deletion-disabled', 'customers.conflict']).toContain(
            asked.error.code,
          );
        }
        expect(switched.ok).toBe(true);
        const pending = (await rows(BUYER)).filter((r) => r.status === 'pending');
        expect(pending).toHaveLength(asked.ok ? 1 : 0);
        // Once the switch committed, no new request starts.
        expect(await ask(OTHER_BUYER)).toEqual({
          ok: false,
          error: { code: 'customers.account-deletion-disabled' },
        });
      }
    });

    it('two setting changes from the same version leave one winner and one conflict', async () => {
      const version = await currentVersion();
      const [a, b] = await Promise.all([change(false, version, 20), change(false, version, 40)]);
      const outcomes = [a, b];
      expect(outcomes.filter((r) => r.ok)).toHaveLength(1);
      const loser = outcomes.find((r) => !r.ok);
      expect(loser).toEqual({ ok: false, error: { code: 'customers.conflict' } });
      expect(await currentVersion()).toBe(version + 1);
      const history = await sql.query(
        `SELECT 1 FROM customers.account_deletion_settings WHERE market_id = $1 AND version = $2`,
        [code, version + 1],
      );
      expect(history.rowCount).toBe(1);
    });

    it('the application role cannot delete a request or change an open column', async () => {
      await ask();
      const [row] = await rows(BUYER);
      await expect(
        db.unitOfWork.run(market, async () => {
          await db.service.tx(market).customersAccountDeletionRequest.deleteMany({
            where: { marketId: code, id: row!.id },
          });
          return ok(undefined);
        }),
      ).rejects.toBeDefined();
      await expect(
        db.unitOfWork.run(market, async () => {
          await db.service.tx(market).customersAccountDeletionRequest.updateMany({
            where: { marketId: code, id: row!.id },
            data: { waitingPeriodDays: 7 },
          });
          return ok(undefined);
        }),
      ).rejects.toBeDefined();
    });

    it('refuses an inconsistent status row (CHECK)', async () => {
      await expect(
        sql.query(
          `INSERT INTO customers.account_deletion_requests
           (id, market_id, tenant_id, account_id, status, waiting_period_days, requested_at, scheduled_for, completed_at)
         VALUES ($1, $2, 'default', $3, 'pending', 14, now(), now() + interval '14 days', now())`,
          [ids.next(), code, OTHER_BUYER],
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  },
);
