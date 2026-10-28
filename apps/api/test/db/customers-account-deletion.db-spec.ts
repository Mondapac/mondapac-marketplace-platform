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
import { AdminCancelAccountDeletion } from '../../src/modules/customers/application/use-cases/admin-cancel-account-deletion.use-case';
import { AdminListAccountDeletions } from '../../src/modules/customers/application/use-cases/admin-list-account-deletions.use-case';
import { AdminRequestAccountDeletion } from '../../src/modules/customers/application/use-cases/admin-request-account-deletion.use-case';
import { CancelAccountDeletion } from '../../src/modules/customers/application/use-cases/cancel-account-deletion.use-case';
import { ExecuteAccountDeletions } from '../../src/modules/customers/application/use-cases/execute-account-deletions.use-case';
import { RequestAccountDeletion } from '../../src/modules/customers/application/use-cases/request-account-deletion.use-case';
import { SetAccountDeletionSettings } from '../../src/modules/customers/application/use-cases/set-account-deletion-settings.use-case';
import { ViewAccountDeletionRequest } from '../../src/modules/customers/application/use-cases/view-account-deletion-request.use-case';
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
          customerAccountExists: () => Promise.resolve(ok({ exists: true })),
          customerAccountOf: (_c: CallContext, accountId: Id<'Account'>) =>
            Promise.resolve(ok({ accountId })),
          endCustomerSessionsForAdmin: () => Promise.resolve(ok({ revokedSessions: 0 })),
          endAllCustomerSessions: () => {
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
          adminBalanceOf: () => Promise.resolve(ok({ available: zero, held: zero })),
        },
        ordering: {
          ownOpenObligations: () => Promise.resolve(ok({ openOrders: 0, pendingRefunds: 0 })),
          openObligationsOf: () => Promise.resolve(ok({ openOrders: 0, pendingRefunds: 0 })),
          adminOpenObligationsOf: () => Promise.resolve(ok({ openOrders: 0, pendingRefunds: 0 })),
        },
        reviews: {
          detachAuthor: () => Promise.resolve(ok({ reviews: 0, ratings: 0 })),
        },
        engagement: {
          forgetAccount: () => Promise.resolve(ok({ events: 0 })),
        },
        stepUp: new RecordingStepUp(clock.now()),
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
      // Other spec files write addresses in this Market of the shared database at the same time:
      // read the rows of this test's two accounts only.
      const left = await sql.query<{ account_id: string }>(
        `SELECT account_id FROM customers.addresses
          WHERE market_id = $1 AND account_id = ANY($2::uuid[])`,
        [code, [BUYER, OTHER_BUYER]],
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

    const requestRepo = () => new PrismaAccountDeletionRequestRepository(db.service);
    const claimNow = (accountId: Id<'Account'>, at = later().now()) =>
      db.unitOfWork.run(
        market,
        async () => {
          const [row] = await rows(accountId);
          return ok(
            await requestRepo().claim(
              market,
              row!.id as Id<'AccountDeletionRequest'>,
              at,
              at.subtract({ minutes: 15 }),
            ),
          );
        },
        { isolation: 'serializable' },
      );
    const statusOf = async (accountId: Id<'Account'>) =>
      (await rows(accountId)).map((r) => r.status);

    it('refuses to cancel a request the job has claimed, and keeps it executing', async () => {
      await ask();
      expect(await claimNow(BUYER)).toEqual(ok(true));
      expect(await statusOf(BUYER)).toEqual(['executing']);
      const cancelled = await new CancelAccountDeletion(gate, deps()).execute(buyer(), {
        reason: 'customer',
      });
      expect(cancelled).toEqual({
        ok: false,
        error: { code: 'customers.account-deletion-in-progress' },
      });
      expect(await statusOf(BUYER)).toEqual(['executing']);
      // The open request still blocks a second one (the partial unique index covers executing).
      expect(await ask()).toEqual({
        ok: false,
        error: { code: 'customers.account-deletion-already-requested' },
      });
      const current = await new ViewAccountDeletionRequest(gate, deps()).execute(buyer(), {});
      expect(current).toMatchObject({ ok: true, value: { status: 'executing' } });
      // No cancelled audit row or event was written.
      const cancelledEvents = await sql.query(
        `SELECT 1 FROM customers.outbox WHERE market_id = $1 AND type = 'customers.account-deletion-cancelled.v1'
          AND aggregate_id = $2`,
        [code, (await rows(BUYER))[0]!.id],
      );
      expect(cancelledEvents.rowCount).toBe(0);
      // A live claim is not taken by another run; a stale one is, and finishes the work.
      const executor = new ExecuteAccountDeletions(gate, { ...deps(), clock: later() });
      await executor.execute(system(), {});
      expect(erased).not.toContain(BUYER);
      const afterStale = new FixedClock(later().now().add({ minutes: 16 }));
      await new ExecuteAccountDeletions(gate, { ...deps(), clock: afterStale }).execute(
        system(),
        {},
      );
      expect(erased).toContain(BUYER);
      expect(await statusOf(BUYER)).toEqual(['completed']);
    });

    it('a cancel racing the executor never leaves a cancelled request erased', async () => {
      for (let round = 0; round < 8; round += 1) {
        const account = id<'Account'>(0xd000 + counter * 16 + round);
        await ask(account);
        erased = [];
        const executor = new ExecuteAccountDeletions(gate, { ...deps(), clock: later() });
        const [cancelled] = await Promise.all([
          new CancelAccountDeletion(gate, deps()).execute(buyer(account), { reason: 'customer' }),
          executor.execute(system(), {}),
        ]);
        const [status] = await statusOf(account);
        if (cancelled.ok) {
          // The 204 case: the request is cancelled and the account was never touched.
          expect(status).toBe('cancelled');
          expect(erased).not.toContain(account);
        } else {
          // In progress or conflict: claimed first. Not found: the whole run finished first.
          expect([
            'customers.account-deletion-in-progress',
            'customers.conflict',
            'customers.account-deletion-request-not-found',
          ]).toContain(cancelled.error.code);
          // Claimed first: the work ran to the end (or can be repeated), never cancelled.
          expect(status).not.toBe('cancelled');
        }
        // Whatever happened, a later run finishes an uncancelled request.
        await new ExecuteAccountDeletions(gate, {
          ...deps(),
          clock: new FixedClock(later().now().add({ minutes: 16 })),
        }).execute(system(), {});
        expect(await statusOf(account)).toEqual([cancelled.ok ? 'cancelled' : 'completed']);
      }
    });

    it('two executor runs at once: only one claims the request and does the erase work', async () => {
      for (let round = 0; round < 5; round += 1) {
        const account = id<'Account'>(0xd800 + counter * 16 + round);
        await ask(account);
        erased = [];
        const [a, b] = await Promise.all([
          new ExecuteAccountDeletions(gate, { ...deps(), clock: later() }).execute(system(), {}),
          new ExecuteAccountDeletions(gate, { ...deps(), clock: later() }).execute(system(), {}),
        ]);
        expect(a.ok && b.ok).toBe(true);
        // Other tests' due requests are taken once as well; this account exactly once.
        expect(erased.filter((e) => e === account)).toHaveLength(1);
        expect(await statusOf(account)).toEqual(['completed']);
        const completedEvents = await sql.query(
          `SELECT 1 FROM customers.outbox WHERE market_id = $1
            AND type = 'customers.account-deletion-completed.v1' AND aggregate_id = $2`,
          [code, (await rows(account))[0]!.id],
        );
        expect(completedEvents.rowCount).toBe(1);
      }
    });

    it('ends every remaining session before the last blocker check and the erase', async () => {
      await ask();
      const order: string[] = [];
      const base = deps();
      const executor = new ExecuteAccountDeletions(gate, {
        ...base,
        clock: later(),
        identity: {
          ...base.identity,
          endAllCustomerSessions: (
            ...args: Parameters<typeof base.identity.endAllCustomerSessions>
          ) => {
            order.push(`end-all:${args[1] === BUYER ? 'buyer' : 'other'}`);
            return base.identity.endAllCustomerSessions(...args);
          },
          eraseCustomerAccount: (
            ...args: Parameters<typeof base.identity.eraseCustomerAccount>
          ) => {
            order.push(`erase:${args[1] === BUYER ? 'buyer' : 'other'}`);
            return base.identity.eraseCustomerAccount(...args);
          },
        },
        ordering: {
          ...base.ordering,
          openObligationsOf: (context, accountId) => {
            if (accountId === BUYER) order.push('blockers:buyer');
            return base.ordering.openObligationsOf(context, accountId);
          },
        },
      });
      await executor.execute(system(), {});
      expect(order.filter((o) => o.endsWith(':buyer'))).toEqual([
        'blockers:buyer',
        'end-all:buyer',
        'blockers:buyer',
        'erase:buyer',
      ]);
    });

    it('refuses an inconsistent claim column (CHECK)', async () => {
      const insert = (status: string, claimedAt: string | null, extra = '') =>
        sql.query(
          `INSERT INTO customers.account_deletion_requests
             (id, market_id, tenant_id, account_id, status, waiting_period_days, requested_at, scheduled_for, claimed_at ${extra ? ', ' + extra.split('=')[0] : ''})
           VALUES ($1, $2, 'default', $3, $4, 14, now(), now() + interval '14 days', $5 ${extra ? ', ' + extra.split('=')[1] : ''})`,
          [ids.next(), code, OTHER_BUYER, status, claimedAt],
        );
      // executing needs a claim; pending must have none.
      await expect(insert('executing', null)).rejects.toMatchObject({ code: '23514' });
      await expect(insert('pending', new Date().toISOString())).rejects.toMatchObject({
        code: '23514',
      });
      await expect(insert('claimed', new Date().toISOString())).rejects.toMatchObject({
        code: '23514',
      });
      // A claimed row is accepted, and it holds the account's one open slot.
      await expect(insert('executing', new Date().toISOString())).resolves.toBeDefined();
      await expect(insert('pending', null)).rejects.toMatchObject({ code: UNIQUE });
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

    describe('admin manual deletion (package 5c)', () => {
      const WHY = 'Buyer asked by phone, identity checked';
      const adminAsk = (accountId = BUYER, ticketRef = 'SUP-2001') =>
        new AdminRequestAccountDeletion(gate, deps()).execute(admin(), {
          accountId,
          ticketRef,
          reason: WHY,
          confirm: true,
        });
      const adminRow = async (accountId: Id<'Account'>) =>
        (
          await sql.query<{
            id: string;
            status: string;
            requested_by: string;
            admin_account_id: string | null;
            ticket_ref: string | null;
            reason: string | null;
            cancel_reason: string | null;
            cancelled_by_admin_id: string | null;
            cancel_note: string | null;
          }>(
            `SELECT id, status, requested_by, admin_account_id, ticket_ref, reason, cancel_reason,
                    cancelled_by_admin_id, cancel_note
               FROM customers.account_deletion_requests
              WHERE market_id = $1 AND account_id = $2 ORDER BY requested_at, id`,
            [code, accountId],
          )
        ).rows;

      it('stores the admin, ticket and reason on the row; audit and event carry no text', async () => {
        await setTo(false, 21);
        const made = await adminAsk();
        expect(made.ok).toBe(true);
        const [row] = await adminRow(BUYER);
        expect(row).toMatchObject({
          status: 'pending',
          requested_by: 'admin',
          admin_account_id: ADMIN,
          ticket_ref: 'SUP-2001',
          reason: WHY,
        });
        const audit = await sql.query<{ after: unknown }>(
          `SELECT after FROM platform.audit_log WHERE market_id = $1 AND action = $2 AND target_id = $3`,
          [code, 'customers.account-deletion.requested-by-admin', row!.id],
        );
        expect(audit.rowCount).toBe(1);
        const event = await sql.query<{ payload: Record<string, unknown> }>(
          `SELECT payload FROM customers.outbox WHERE market_id = $1 AND aggregate_id = $2`,
          [code, row!.id],
        );
        expect(event.rows.map((r) => Object.keys(r.payload).sort())).toEqual([
          ['scheduledFor', 'waitingPeriodDays'],
        ]);
        const written = JSON.stringify([audit.rows, event.rows]);
        expect(written).not.toContain('SUP-2001');
        expect(written).not.toContain(WHY);
        expect(ended).toBe(0);
      });

      it('keeps one open request per account across buyer and admin requests', async () => {
        expect((await ask()).ok).toBe(true);
        expect(await adminAsk()).toEqual({
          ok: false,
          error: { code: 'customers.account-deletion-already-requested' },
        });
        const results = await Promise.all([adminAsk(OTHER_BUYER), adminAsk(OTHER_BUYER)]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
      });

      it('cancels by admin with the admin and note on the row, once, and lists only pending ones', async () => {
        await adminAsk();
        await adminAsk(OTHER_BUYER, 'SUP-2002');
        const [row] = await adminRow(BUYER);
        const listed = await new AdminListAccountDeletions(gate, deps()).execute(admin(), {});
        expect(listed.ok && listed.value.entries.map((e) => e.requestId)).toEqual(
          expect.arrayContaining([row!.id]),
        );
        const cancel = () =>
          new AdminCancelAccountDeletion(gate, deps()).execute(admin(), {
            requestId: row!.id,
            reason: 'Buyer changed their mind',
          });
        expect((await cancel()).ok).toBe(true);
        expect(await cancel()).toEqual({
          ok: false,
          error: { code: 'customers.account-deletion-request-not-found' },
        });
        expect((await adminRow(BUYER))[0]).toMatchObject({
          status: 'cancelled',
          cancel_reason: 'admin',
          cancelled_by_admin_id: ADMIN,
          cancel_note: 'Buyer changed their mind',
        });
        const after = await new AdminListAccountDeletions(gate, deps()).execute(admin(), {});
        expect(after.ok && after.value.entries.map((e) => e.requestId)).not.toContain(row!.id);
        // The buyer may ask again once it is cancelled.
        expect((await ask()).ok).toBe(true);
      });

      it('pages the pending list by a keyset cursor and stays in its Market', async () => {
        await adminAsk();
        await adminAsk(OTHER_BUYER, 'SUP-2003');
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 200; page += 1) {
          const result = await new AdminListAccountDeletions(gate, deps()).execute(admin(), {
            limit: 1,
            ...(cursor === null ? {} : { cursor }),
          });
          if (!result.ok) throw new Error(result.error.code);
          seen.push(...result.value.entries.map((e) => e.accountId));
          cursor = result.value.nextCursor;
          if (cursor === null) break;
        }
        expect(seen).toEqual(expect.arrayContaining([BUYER, OTHER_BUYER]));
        expect(new Set(seen).size).toBe(seen.length);
        const foreign = await sql.query(
          `SELECT 1 FROM customers.account_deletion_requests WHERE market_id <> $1 AND id = ANY($2)`,
          [code, seen],
        );
        expect(foreign.rowCount).toBe(0);
      });

      it('the application role cannot rewrite the ticket, reason or admin of a request', async () => {
        await adminAsk();
        const [row] = await adminRow(BUYER);
        for (const data of [
          { ticketRef: 'SUP-9' },
          { reason: 'changed' },
          { adminAccountId: BUYER },
        ]) {
          await expect(
            db.unitOfWork.run(market, async () => {
              await db.service.tx(market).customersAccountDeletionRequest.updateMany({
                where: { marketId: code, id: row!.id },
                data,
              });
              return ok(undefined);
            }),
          ).rejects.toBeDefined();
        }
      });

      it('refuses inconsistent admin columns and a malformed ticket (CHECK)', async () => {
        const insert = (cols: string, values: string) =>
          sql.query(
            `INSERT INTO customers.account_deletion_requests
               (id, market_id, tenant_id, account_id, status, waiting_period_days, requested_at, scheduled_for, ${cols})
             VALUES ($1, $2, 'default', $3, 'pending', 14, now(), now() + interval '14 days', ${values})`,
            [ids.next(), code, id<'Account'>(0xfe00 + counter)],
          );
        await expect(insert('requested_by', "'admin'")).rejects.toMatchObject({ code: '23514' });
        await expect(
          insert(
            'requested_by, admin_account_id, ticket_ref, reason',
            `'customer', '${ADMIN}', 'T-1', 'r'`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          insert(
            'requested_by, admin_account_id, ticket_ref, reason',
            `'admin', '${ADMIN}', 'has space', 'r'`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          insert(
            'requested_by, admin_account_id, ticket_ref, reason',
            `'admin', '${ADMIN}', 'T-1', ''`,
          ),
        ).rejects.toMatchObject({ code: '23514' });
        await expect(
          sql.query(
            `INSERT INTO customers.account_deletion_requests
               (id, market_id, tenant_id, account_id, status, waiting_period_days, requested_at, scheduled_for, cancelled_at, cancel_reason)
             VALUES ($1, $2, 'default', $3, 'cancelled', 14, now(), now() + interval '14 days', now(), 'admin')`,
            [ids.next(), code, id<'Account'>(0xfd00 + counter)],
          ),
        ).rejects.toMatchObject({ code: '23514' });
      });
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
