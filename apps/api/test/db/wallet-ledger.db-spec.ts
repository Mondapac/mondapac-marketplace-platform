import { err, money, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  testAuthenticatedActor,
  testCallContext,
} from '@mondapac/shared-kernel/testing';
import { Client } from 'pg';
import type { AuditWriter } from '../../src/platform/audit/audit-writer';
import { createUseCaseGate } from '../../src/platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../src/platform/market-config/market-config';
import { MarketRegistry } from '../../src/platform/market-config/market-registry';
import { UuidV7IdGenerator } from '../../src/platform/ids/uuid-v7-id-generator';
import type { WalletDependencies } from '../../src/modules/wallet/application/wallet-dependencies';
import { BalanceOf } from '../../src/modules/wallet/application/use-cases/balance-of.use-case';
import { CaptureHold } from '../../src/modules/wallet/application/use-cases/capture-hold.use-case';
import { ExpireWalletCredit } from '../../src/modules/wallet/application/use-cases/expire-wallet-credit.use-case';
import { GrantCredit } from '../../src/modules/wallet/application/use-cases/grant-credit.use-case';
import { PlaceHold } from '../../src/modules/wallet/application/use-cases/place-hold.use-case';
import { ReleaseHold } from '../../src/modules/wallet/application/use-cases/release-hold.use-case';
import { SetWalletStatus } from '../../src/modules/wallet/application/use-cases/set-wallet-status.use-case';
import { ViewMyHistory } from '../../src/modules/wallet/application/use-cases/view-my-history.use-case';
import { ViewMyWallet } from '../../src/modules/wallet/application/use-cases/view-my-wallet.use-case';
import { ConfigWalletPolicy } from '../../src/modules/wallet/infrastructure/config-wallet-policy';
import { PrismaMarketSettingRepository } from '../../src/modules/wallet/infrastructure/prisma-market-setting.repository';
import { PrismaWalletRepository } from '../../src/modules/wallet/infrastructure/prisma-wallet.repository';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS, TEST_MARKETS } from '../support/test-config';
import { createPersistence, marketOf, type Persistence } from './persistence-support';
import { ownerTestDatabaseUrl, testDatabaseUrl } from './test-database';

// The wallet ledger as the application role, in both Market fixtures: the tables' own guards (a
// journal must balance, insert-only rows, the lot and hold guards, the CHECKs, no card or bank
// vocabulary), and the use cases on the real stores: idempotency, the Market cap, soonest-expiring
// lots first, release restoring the exact lots, the expiry sweeps, the switch's hard rules and two
// parallel holds on one wallet that never overspend.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const CHECK = '23514';
const NO_PRIVILEGE = '42501';
const RESTRICT = '23001';
const UNIQUE = '23505';

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each(TEST_MARKETS)('wallet ledger in market %s (database)', (code) => {
  const market = marketOf(code);
  const config = markets.get(market.marketId);
  const currency = config.defaultCurrency;
  const cap = BigInt(config.wallet!.balanceCapMinor);
  const promoMonths = config.wallet!.promoExpiryMonths;
  const amount = (minor: bigint) => money(minor, currency);
  const clock = new FixedClock(T0);
  const ids = new UuidV7IdGenerator(clock);
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const system = testCallContext(market, 'system', 'wallet-db-system-1');
  const adminCtx = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'admin',
      accountId: ids.next<'Account'>(),
      sessionId: ids.next<'Session'>(),
      sellerId: null,
    }),
    'wallet-db-admin-1',
  );
  const customerCtx = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: ids.next<'Session'>(),
        sellerId: null,
      }),
      'wallet-db-customer-1',
    );

  let db: Persistence;
  let sql: Client;
  let owner: Client;
  let audit: RecordingAudit;
  let deps: WalletDependencies;
  let n = 0;

  beforeAll(async () => {
    db = createPersistence();
    sql = new Client({ connectionString: testDatabaseUrl() });
    owner = new Client({ connectionString: ownerTestDatabaseUrl() });
    await sql.connect();
    await owner.connect();
    audit = new RecordingAudit();
    deps = {
      unitOfWork: db.unitOfWork,
      wallet: new PrismaWalletRepository(db.service, ids),
      settings: new PrismaMarketSettingRepository(db.service),
      policy: new ConfigWalletPolicy(markets),
      audit,
      ids,
      clock,
    };
  });
  afterAll(async () => {
    await db.close();
    await sql.end();
    await owner.end();
  });

  const code_ = (promise: Promise<unknown>) =>
    promise.then(
      () => 'allowed',
      (error: { code?: string }) => error.code,
    );
  const key = (label: string) => `${label}-${code}-${(n += 1)}-db`;
  const turn = (status: string, reasonCode?: string) =>
    new SetWalletStatus(gate, deps).execute(adminCtx, { status, reasonCode });
  const grant = (
    customerAccountId: Id<'Account'>,
    minor: bigint,
    source: 'promo' | 'refund' = 'promo',
    idempotencyKey = key('grant'),
    context = system,
  ) =>
    new GrantCredit(gate, deps).execute(context, {
      customerAccountId,
      source,
      amount: amount(minor),
      reasonCode: 'welcome',
      idempotencyKey,
    });
  const hold = (customerAccountId: Id<'Account'>, orderId: Id<'Order'>, minor: bigint, hours = 2) =>
    new PlaceHold(gate, deps).execute(system, {
      customerAccountId,
      orderId,
      amount: amount(minor),
      expiresAt: clock.now().add({ hours }),
      idempotencyKey: key('hold'),
    });
  const settle = (
    what: 'capture' | 'release',
    customerAccountId: Id<'Account'>,
    orderId: Id<'Order'>,
  ) =>
    (what === 'capture' ? new CaptureHold(gate, deps) : new ReleaseHold(gate, deps)).execute(
      system,
      {
        customerAccountId,
        orderId,
        idempotencyKey: key(what),
      },
    );
  const balanceOf = async (customerAccountId: Id<'Account'>) => {
    const r = await new BalanceOf(gate, deps).execute(system, { customerAccountId });
    if (!r.ok) throw new Error(r.error.code);
    return [r.value.available.amount, r.value.held.amount] as const;
  };
  const rows = async (text: string, values: unknown[] = []) =>
    (await owner.query(text, values)).rows as Record<string, unknown>[];

  // ---- the tables' own guards ---------------------------------------------------------------

  describe('tables', () => {
    // A scratch Market id: the raw rows below must not count as history of the Market under test.
    const mk = `T${code}`;
    const accountRow = async (
      kind = 'credit_liability',
      customer: string | null = ids.next<'Account'>(),
    ) => {
      const id = ids.next<'WalletAccount'>();
      await sql.query(
        `INSERT INTO wallet.accounts (id, market_id, tenant_id, kind, customer_account_id, currency, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', now())`,
        [id, mk, 'default', kind, customer, currency],
      );
      return id;
    };
    const journalSql = (id: string, key_: string): [string, unknown[]] => [
      `INSERT INTO wallet.journals (id, market_id, tenant_id, kind, idempotency_key, fingerprint, actor_kind, actor_id, reason_code, order_id, wallet_account_id, result, created_at)
       VALUES ($1, $2, $3, 'grant-promo', $4, 'fp', 'system', NULL, 'welcome', NULL, NULL, '{}'::jsonb, now())`,
      [id, mk, 'default', key_],
    ];
    const postingSql = (
      journalId: string,
      accountId: string,
      minor: bigint,
    ): [string, unknown[]] => [
      `INSERT INTO wallet.postings (id, market_id, tenant_id, journal_id, account_id, amount_minor, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [ids.next(), mk, 'default', journalId, accountId, minor, currency],
    ];
    /** One transaction of a journal with the given legs; the deferred constraint fires at COMMIT. */
    const writeJournal = async (legs: readonly [string, bigint][]) => {
      const journalId = ids.next<'WalletJournal'>();
      const client = new Client({ connectionString: testDatabaseUrl() });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(...journalSql(journalId, key('raw')));
        for (const [accountId, minor] of legs)
          await client.query(...postingSql(journalId, accountId, minor));
        await client.query('COMMIT');
        return journalId;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    };

    it('has no card or bank vocabulary in any wallet column', async () => {
      const columns = await rows(
        `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'wallet'`,
      );
      const FORBIDDEN = new Set([
        'card',
        'bank',
        'iban',
        'bsb',
        'pan',
        'cvv',
        'cvc',
        'stripe',
        'routing',
        'swift',
        'bic',
        'paypal',
        'payout',
        'withdrawal',
        'transfer',
        'p2p',
      ]);
      const offenders = columns.filter((column) =>
        String(column.column_name)
          .split('_')
          .some((token) => FORBIDDEN.has(token)),
      );
      expect(columns.length).toBeGreaterThan(40);
      expect(offenders).toEqual([]);
    });

    it('commits a balanced journal and refuses an unbalanced one, a lone leg and a journal with no legs', async () => {
      const a = await accountRow();
      const b = await accountRow();
      await expect(
        writeJournal([
          [a, 500n],
          [b, -500n],
        ]),
      ).resolves.toBeDefined();
      expect(
        await code_(
          writeJournal([
            [a, 500n],
            [b, -400n],
          ]),
        ),
      ).toBe(CHECK);
      expect(await code_(writeJournal([[a, 500n]]))).toBe(CHECK);
      expect(await code_(writeJournal([]))).toBe(CHECK);
      expect(
        await code_(
          writeJournal([
            [a, 500n],
            [b, -300n],
            [a, -100n],
          ]),
        ),
      ).toBe(CHECK);
      // Three legs that do sum to zero are fine.
      await expect(
        writeJournal([
          [a, 500n],
          [b, -300n],
          [b, -200n],
        ]),
      ).resolves.toBeDefined();
      // A leg of zero is never written.
      expect(
        await code_(
          writeJournal([
            [a, 0n],
            [b, 0n],
          ]),
        ),
      ).toBe(CHECK);
    });

    it('never changes or removes a journal, a leg or a hold lot, for the application or the owner', async () => {
      const a = await accountRow();
      const b = await accountRow();
      const journalId = await writeJournal([
        [a, 5n],
        [b, -5n],
      ]);
      for (const client of [sql, owner]) {
        const denied = client === sql ? NO_PRIVILEGE : RESTRICT;
        expect(
          await code_(
            client.query(`UPDATE wallet.journals SET reason_code = 'x1' WHERE id = $1`, [
              journalId,
            ]),
          ),
        ).toBe(denied);
        expect(
          await code_(client.query(`DELETE FROM wallet.journals WHERE id = $1`, [journalId])),
        ).toBe(denied);
        expect(
          await code_(
            client.query(`UPDATE wallet.postings SET amount_minor = 9 WHERE journal_id = $1`, [
              journalId,
            ]),
          ),
        ).toBe(denied);
        expect(
          await code_(
            client.query(`DELETE FROM wallet.postings WHERE journal_id = $1`, [journalId]),
          ),
        ).toBe(denied);
        expect(await code_(client.query(`TRUNCATE wallet.journals, wallet.postings CASCADE`))).toBe(
          client === sql ? NO_PRIVILEGE : RESTRICT,
        );
      }
    });

    it('never deletes an account, lot, hold or balance, and the switch row cannot be deleted', async () => {
      for (const table of [
        'accounts',
        'lots',
        'holds',
        'balances',
        'market_settings',
        'hold_lots',
      ]) {
        expect(await code_(sql.query(`DELETE FROM wallet.${table}`))).toBe(NO_PRIVILEGE);
        expect(await code_(owner.query(`DELETE FROM wallet.${table} WHERE false`))).toBe('allowed');
        expect(await code_(owner.query(`TRUNCATE wallet.${table} CASCADE`))).toBe(RESTRICT);
      }
    });

    it('refuses a negative balance, a lot over its original and promo credit that never expires', async () => {
      const customer = ids.next<'Account'>();
      const wallet = await accountRow('credit_liability', customer);
      const bad = (available: bigint, held: bigint) =>
        sql.query(
          `INSERT INTO wallet.balances (wallet_account_id, market_id, tenant_id, currency, available_minor, held_minor, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [wallet, mk, 'default', currency, available, held],
        );
      expect(await code_(bad(-1n, 0n))).toBe(CHECK);
      expect(await code_(bad(0n, -1n))).toBe(CHECK);
      const journal = ids.next<'WalletJournal'>();
      const lot = (source: string, original: bigint, remaining: bigint, expires: string | null) =>
        sql.query(
          `INSERT INTO wallet.lots (id, market_id, tenant_id, wallet_account_id, source, journal_id, original_minor, remaining_minor, currency, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
          [
            ids.next(),
            mk,
            'default',
            wallet,
            source,
            journal,
            original,
            remaining,
            currency,
            expires,
          ],
        );
      expect(await code_(lot('promo', 100n, 101n, '2027-01-01T00:00:00Z'))).toBe(CHECK);
      expect(await code_(lot('promo', 100n, -1n, '2027-01-01T00:00:00Z'))).toBe(CHECK);
      expect(await code_(lot('promo', 0n, 0n, '2027-01-01T00:00:00Z'))).toBe(CHECK);
      expect(await code_(lot('promo', 100n, 100n, null))).toBe(CHECK);
      expect(await code_(lot('refund', 100n, 100n, '2027-01-01T00:00:00Z'))).toBe(CHECK);
      expect(await code_(lot('gift', 100n, 100n, null))).toBe(CHECK);
      expect(await code_(lot('promo', 100n, 100n, '2027-01-01T00:00:00Z'))).toBe('allowed');
    });

    it('keeps a customer wallet one per customer and the internal accounts one per kind', async () => {
      const customer = ids.next<'Account'>();
      await accountRow('credit_liability', customer);
      expect(await code_(accountRow('credit_liability', customer))).toBe(UNIQUE);
      expect(await code_(accountRow('credit_liability', null))).toBe(CHECK);
      expect(await code_(accountRow('breakage_income', customer))).toBe(CHECK);
      expect(await code_(accountRow('bank', null))).toBe(CHECK);
      // An internal account exists once per kind and Market.
      expect(await code_(accountRow('breakage_income', null))).toBe('allowed');
      expect(await code_(accountRow('breakage_income', null))).toBe(UNIQUE);
    });

    it('guards a lot (only remaining, only down unless a settled hold gives credit back) and a hold (leaves held once)', async () => {
      const customer = ids.next<'Account'>();
      const wallet = await accountRow('credit_liability', customer);
      const lotId = ids.next<'WalletLot'>();
      const holdId = ids.next<'WalletHold'>();
      await sql.query(
        `INSERT INTO wallet.lots (id, market_id, tenant_id, wallet_account_id, source, journal_id, original_minor, remaining_minor, currency, expires_at, created_at)
         VALUES ($1, $2, $3, $4, 'refund', $5, 100, 100, $6, NULL, now())`,
        [lotId, mk, 'default', wallet, ids.next(), currency],
      );
      expect(
        await code_(
          sql.query(`UPDATE wallet.lots SET remaining_minor = 40 WHERE id = $1`, [lotId]),
        ),
      ).toBe('allowed');
      expect(
        await code_(
          sql.query(`UPDATE wallet.lots SET remaining_minor = 50 WHERE id = $1`, [lotId]),
        ),
      ).toBe(RESTRICT);
      expect(
        await code_(
          sql.query(`UPDATE wallet.lots SET original_minor = 500 WHERE id = $1`, [lotId]),
        ),
      ).toBe(NO_PRIVILEGE);
      expect(
        await code_(owner.query(`UPDATE wallet.lots SET source = 'promo' WHERE id = $1`, [lotId])),
      ).toBe(RESTRICT);
      await sql.query(
        `INSERT INTO wallet.holds (id, market_id, tenant_id, wallet_account_id, order_id, amount_minor, currency, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 60, $6, 'held', now(), now())`,
        [holdId, mk, 'default', wallet, ids.next(), currency],
      );
      await sql.query(
        `INSERT INTO wallet.hold_lots (hold_id, lot_id, market_id, tenant_id, amount_minor) VALUES ($1, $2, $3, $4, 60)`,
        [holdId, lotId, mk, 'default'],
      );
      // A held hold gives nothing back yet.
      expect(
        await code_(
          sql.query(`UPDATE wallet.lots SET remaining_minor = 100 WHERE id = $1`, [lotId]),
        ),
      ).toBe(RESTRICT);
      expect(
        await code_(
          sql.query(
            `UPDATE wallet.holds SET status = 'released', resolved_at = now() WHERE id = $1`,
            [holdId],
          ),
        ),
      ).toBe('allowed');
      expect(
        await code_(
          sql.query(`UPDATE wallet.lots SET remaining_minor = 100 WHERE id = $1`, [lotId]),
        ),
      ).toBe('allowed');
      expect(
        await code_(
          sql.query(`UPDATE wallet.lots SET remaining_minor = 100 WHERE id = $1`, [lotId]),
        ),
      ).toBe('allowed');
      // A settled hold never changes again, and its amount never does.
      expect(
        await code_(
          sql.query(`UPDATE wallet.holds SET status = 'captured' WHERE id = $1`, [holdId]),
        ),
      ).toBe(RESTRICT);
      expect(
        await code_(sql.query(`UPDATE wallet.holds SET amount_minor = 1 WHERE id = $1`, [holdId])),
      ).toBe(NO_PRIVILEGE);
      expect(
        await code_(
          sql.query(`UPDATE wallet.accounts SET status = 'frozen' WHERE id = $1`, [wallet]),
        ),
      ).toBe('allowed');
      expect(
        await code_(
          owner.query(`UPDATE wallet.accounts SET kind = 'holds' WHERE id = $1`, [wallet]),
        ),
      ).toBe(RESTRICT);
    });

    it('keeps a single hold per order and a single journal per idempotency key, per Market', async () => {
      const customer = ids.next<'Account'>();
      const wallet = await accountRow('credit_liability', customer);
      const order = ids.next<'Order'>();
      const insertHold = (market_id = mk) =>
        sql.query(
          `INSERT INTO wallet.holds (id, market_id, tenant_id, wallet_account_id, order_id, amount_minor, currency, status, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, 60, $6, 'held', now(), now())`,
          [ids.next(), market_id, 'default', wallet, order, currency],
        );
      expect(await code_(insertHold())).toBe('allowed');
      expect(await code_(insertHold())).toBe(UNIQUE);
    });

    it('moves the switch only to the four states, with a reason exactly for paused and frozen', async () => {
      const upsert = (mk: string, status: string, reason: string | null) =>
        sql.query(
          `INSERT INTO wallet.market_settings (market_id, tenant_id, status, reason_code, updated_at, updated_by_account_id)
           VALUES ($1, 'default', $2, $3, now(), $4)
           ON CONFLICT (market_id) DO UPDATE SET status = EXCLUDED.status, reason_code = EXCLUDED.reason_code`,
          [mk, status, reason, ids.next()],
        );
      const scratch = `${mk}S`;
      expect(await code_(upsert(scratch, 'on', null))).toBe(CHECK);
      expect(await code_(upsert(scratch, 'paused', null))).toBe(CHECK);
      expect(await code_(upsert(scratch, 'frozen', null))).toBe(CHECK);
      expect(await code_(upsert(scratch, 'active', 'wind-down'))).toBe(CHECK);
      expect(await code_(upsert(scratch, 'off', 'wind-down'))).toBe(CHECK);
      expect(await code_(upsert(scratch, 'paused', 'wind-down'))).toBe('allowed');
      // With a journal in that Market the row cannot go back to off, whoever asks.
      const client = new Client({ connectionString: testDatabaseUrl() });
      await client.connect();
      const journalId = ids.next<'WalletJournal'>();
      const legA = ids.next<'WalletAccount'>();
      const legB = ids.next<'WalletAccount'>();
      await client.query('BEGIN');
      for (const [accountId, kind] of [
        [legA, 'promo_expense'],
        [legB, 'refund_clearing'],
      ] as const) {
        await client.query(
          `INSERT INTO wallet.accounts (id, market_id, tenant_id, kind, customer_account_id, currency, status, created_at)
           VALUES ($1, $2, 'default', $3, NULL, $4, 'active', now())`,
          [accountId, scratch, kind, currency],
        );
      }
      await client.query(
        `INSERT INTO wallet.journals (id, market_id, tenant_id, kind, idempotency_key, fingerprint, actor_kind, actor_id, reason_code, order_id, wallet_account_id, result, created_at)
         VALUES ($1, $2, 'default', 'grant-promo', $3, 'fp', 'system', NULL, 'welcome', NULL, NULL, '{}'::jsonb, now())`,
        [journalId, scratch, key('scratch')],
      );
      for (const [accountId, minor] of [
        [legA, 1n],
        [legB, -1n],
      ] as const) {
        await client.query(
          `INSERT INTO wallet.postings (id, market_id, tenant_id, journal_id, account_id, amount_minor, currency)
           VALUES ($1, $2, 'default', $3, $4, $5, $6)`,
          [ids.next(), scratch, journalId, accountId, minor, currency],
        );
      }
      await client.query('COMMIT');
      await client.end();
      expect(await code_(upsert(scratch, 'off', null))).toBe(RESTRICT);
      expect(await code_(upsert(scratch, 'active', null))).toBe('allowed');
    });
  });

  // ---- the use cases on the real stores -----------------------------------------------------

  describe('use cases', () => {
    it('is off until an admin turns it on: nothing is written, then the switch round trips with one audit row per change', async () => {
      const customer = ids.next<'Account'>();
      expect(await grant(customer, 100n)).toEqual(err({ code: 'wallet.disabled' }));
      expect(await new ViewMyWallet(gate, deps).execute(customerCtx(customer), {})).toEqual(
        err({ code: 'wallet.disabled' }),
      );
      expect((await turn('active')).ok).toBe(true);
      expect((await turn('active')).ok).toBe(true);
      expect((await turn('off')).ok).toBe(true);
      expect(await grant(customer, 100n)).toEqual(err({ code: 'wallet.disabled' }));
      expect((await turn('active')).ok).toBe(true);
      expect(audit.entries.filter((e) => e.action === 'wallet.market-status.changed')).toHaveLength(
        3,
      );
    });

    it('grants, spends soonest-expiring first, and a release restores the exact lots', async () => {
      const customer = ids.next<'Account'>();
      expect((await grant(customer, 300n, 'refund')).ok).toBe(true);
      expect((await grant(customer, 300n, 'promo')).ok).toBe(true);
      const order = ids.next<'Order'>();
      expect((await hold(customer, order, 450n)).ok).toBe(true);
      const lotRows = () =>
        rows(
          `SELECT l.source, l.remaining_minor::text AS remaining, l.expires_at
             FROM wallet.lots l JOIN wallet.accounts a ON a.id = l.wallet_account_id
            WHERE a.customer_account_id = $1 ORDER BY l.source`,
          [customer],
        );
      expect((await lotRows()).map((r) => [r.source, r.remaining])).toEqual([
        ['promo', '0'],
        ['refund', '150'],
      ]);
      expect(await balanceOf(customer)).toEqual([150n, 450n]);
      expect((await settle('release', customer, order)).ok).toBe(true);
      expect((await lotRows()).map((r) => [r.source, r.remaining])).toEqual([
        ['promo', '300'],
        ['refund', '300'],
      ]);
      expect(await balanceOf(customer)).toEqual([600n, 0n]);
      const promo = (await lotRows()).find((r) => r.source === 'promo')!;
      expect((promo.expires_at as Date).toISOString()).toBe(
        T0.toZonedDateTimeISO(config.timezone)
          .add({ months: promoMonths })
          .toInstant()
          .toString()
          .replace('Z', '.000Z'),
      );
    });

    it('captures a hold once and keeps every journal balanced with the cache equal to the lots', async () => {
      const customer = ids.next<'Account'>();
      await grant(customer, 700n, 'promo');
      const order = ids.next<'Order'>();
      await hold(customer, order, 500n);
      expect((await settle('capture', customer, order)).ok).toBe(true);
      expect(await settle('capture', customer, order)).toEqual(
        err({ code: 'wallet.hold-not-held' }),
      );
      expect(await balanceOf(customer)).toEqual([200n, 0n]);
      const unbalanced = await rows(
        `SELECT journal_id FROM wallet.postings GROUP BY journal_id HAVING sum(amount_minor) <> 0`,
      );
      expect(unbalanced).toEqual([]);
      const cache = await rows(
        `SELECT b.available_minor::text AS cached,
                (SELECT COALESCE(sum(l.remaining_minor), 0)::text FROM wallet.lots l WHERE l.wallet_account_id = b.wallet_account_id) AS lots
           FROM wallet.balances b JOIN wallet.accounts a ON a.id = b.wallet_account_id
          WHERE a.customer_account_id = $1`,
        [customer],
      );
      expect(cache).toEqual([{ cached: '200', lots: '200' }]);
    });

    it('answers a repeated key with the first result and a reused key with idempotency.key-reused', async () => {
      const customer = ids.next<'Account'>();
      const k = key('idem');
      const first = await grant(customer, 100n, 'promo', k);
      expect(await grant(customer, 100n, 'promo', k)).toEqual(first);
      expect(await grant(customer, 101n, 'promo', k)).toEqual(
        err({ code: 'idempotency.key-reused' }),
      );
      expect(await balanceOf(customer)).toEqual([100n, 0n]);
      expect(
        await rows(`SELECT count(*)::int AS n FROM wallet.journals WHERE idempotency_key = $1`, [
          k,
        ]),
      ).toEqual([{ n: 1 }]);
    });

    it('refuses a grant over the Market cap, even when parallel', async () => {
      const customer = ids.next<'Account'>();
      expect((await grant(customer, cap - 10n)).ok).toBe(true);
      expect(await grant(customer, 11n)).toEqual(err({ code: 'wallet.cap-exceeded' }));
      const results = await Promise.all([
        grant(customer, 10n),
        grant(customer, 10n),
        grant(customer, 10n),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(
        results.filter((r) => !r.ok).every((r) => !r.ok && r.error.code === 'wallet.cap-exceeded'),
      ).toBe(true);
      expect((await balanceOf(customer))[0]).toBe(cap);
    });

    it('never overspends: two parallel holds on one wallet, and parallel same-key grants write one journal', async () => {
      const customer = ids.next<'Account'>();
      await grant(customer, 1000n, 'refund');
      const results = await Promise.all([
        hold(customer, ids.next<'Order'>(), 600n),
        hold(customer, ids.next<'Order'>(), 600n),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual(err({ code: 'wallet.insufficient-funds' }));
      expect(await balanceOf(customer)).toEqual([400n, 600n]);
      const many = await Promise.all(
        Array.from({ length: 6 }, () => hold(customer, ids.next<'Order'>(), 100n)),
      );
      expect(many.filter((r) => r.ok)).toHaveLength(4);
      expect(await balanceOf(customer)).toEqual([0n, 1000n]);

      const sameKey = key('race');
      const other_ = ids.next<'Account'>();
      const same = await Promise.all([1, 2, 3, 4].map(() => grant(other_, 50n, 'promo', sameKey)));
      expect(same.every((r) => r.ok)).toBe(true);
      expect(new Set(same.map((r) => (r.ok ? r.value.journalId : ''))).size).toBe(1);
      expect(await balanceOf(other_)).toEqual([50n, 0n]);
    });

    it('sweeps expired holds in every state but off, and expired promo credit into breakage income', async () => {
      const customer = ids.next<'Account'>();
      await grant(customer, 600n, 'promo');
      await grant(customer, 400n, 'refund');
      const order = ids.next<'Order'>();
      await hold(customer, order, 700n, 1);
      await turn('frozen', 'security-incident');
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      const swept = await new ExpireWalletCredit(gate, deps).execute(system, {});
      expect(swept).toMatchObject({ ok: true, value: { failed: [] } });
      expect(await balanceOf(customer)).toEqual([1000n, 0n]);
      expect(await rows(`SELECT status FROM wallet.holds WHERE order_id = $1`, [order])).toEqual([
        { status: 'expired' },
      ]);
      // Reads still work frozen; the customer sees the restored balance.
      expect(await new ViewMyWallet(gate, deps).execute(customerCtx(customer), {})).toMatchObject({
        ok: true,
        value: { available: 1000n, marketStatus: 'frozen' },
      });
      expect((await new ViewMyHistory(gate, deps).execute(customerCtx(customer), {})).ok).toBe(
        true,
      );
      await turn('active');
      clock.advance(Temporal.Duration.from({ hours: 24 * 31 * promoMonths }));
      const second = await new ExpireWalletCredit(gate, deps).execute(system, {});
      expect(second.ok && second.value.expiredLots).toBeGreaterThanOrEqual(1);
      expect(await balanceOf(customer)).toEqual([400n, 0n]);
      const breakage = await rows(
        `SELECT COALESCE(sum(p.amount_minor), 0)::text AS total
           FROM wallet.postings p JOIN wallet.accounts a ON a.id = p.account_id
          WHERE a.kind = 'breakage_income' AND a.market_id = $1`,
        [market.marketId],
      );
      expect(BigInt(breakage[0]!.total as string)).toBeGreaterThanOrEqual(600n);
      // Nothing was deleted: the lot is still there, empty.
      expect(
        await rows(
          `SELECT l.remaining_minor::text AS r FROM wallet.lots l JOIN wallet.accounts a ON a.id = l.wallet_account_id
            WHERE a.customer_account_id = $1 AND l.source = 'promo'`,
          [customer],
        ),
      ).toEqual([{ r: '0' }]);
    });

    it('hard rules: paused and frozen keep balances and lots, settle holds, and off is refused with history', async () => {
      const customer = ids.next<'Account'>();
      await grant(customer, 500n, 'refund');
      const order = ids.next<'Order'>();
      await hold(customer, order, 200n);
      const before = await balanceOf(customer);
      expect((await turn('paused', 'wind-down')).ok).toBe(true);
      expect((await turn('frozen', 'security-incident')).ok).toBe(true);
      expect(await balanceOf(customer)).toEqual(before);
      expect(await grant(customer, 1n)).toEqual(err({ code: 'wallet.frozen' }));
      expect(await settle('capture', customer, order)).toEqual(err({ code: 'wallet.frozen' }));
      expect((await turn('paused', 'wind-down')).ok).toBe(true);
      expect(await grant(customer, 1n)).toEqual(err({ code: 'wallet.paused' }));
      expect((await settle('capture', customer, order)).ok).toBe(true);
      expect(await turn('off')).toEqual(err({ code: 'wallet.cannot-turn-off-with-history' }));
      expect((await turn('active')).ok).toBe(true);
      expect(
        await rows(`SELECT status FROM wallet.market_settings WHERE market_id = $1`, [
          market.marketId,
        ]),
      ).toEqual([{ status: 'active' }]);
    });
  });
});
