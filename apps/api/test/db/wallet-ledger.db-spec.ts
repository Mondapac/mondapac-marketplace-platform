import { err, money, ok, Temporal } from '@mondapac/shared-kernel';
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
    beforeAll(async () => {
      await sql.query(
        `INSERT INTO wallet.market_settings (market_id, tenant_id, status, reason_code, updated_at, updated_by_account_id)
         VALUES ($1, 'default', 'active', NULL, now(), $2) ON CONFLICT (market_id) DO NOTHING`,
        [mk, ids.next()],
      );
    });
    /**
     * Runs the statements in one transaction as the given role and rolls it back: the answer is
     * the code of the first error, or 'allowed'. The deferred ledger checks, which run at COMMIT,
     * never run, so this probes the row guards alone.
     */
    const probe = async (
      statements: readonly [string, unknown[]][],
      url: string = testDatabaseUrl(),
    ) => {
      const client = new Client({ connectionString: url });
      await client.connect();
      try {
        await client.query('BEGIN');
        for (const statement of statements) await client.query(...statement);
        return 'allowed';
      } catch (error) {
        return (error as { code?: string }).code;
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    };
    const accountRow = async (
      kind = 'credit_liability',
      customer: string | null = ids.next<'Account'>(),
      market_id = mk,
    ) => {
      const id = ids.next<'WalletAccount'>();
      await sql.query(
        `INSERT INTO wallet.accounts (id, market_id, tenant_id, kind, customer_account_id, currency, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', now())`,
        [id, market_id, 'default', kind, customer, currency],
      );
      return id;
    };
    const journalSql = (id: string, key_: string, market_id = mk): [string, unknown[]] => [
      `INSERT INTO wallet.journals (id, market_id, tenant_id, kind, idempotency_key, fingerprint, actor_kind, actor_id, reason_code, order_id, wallet_account_id, result, created_at)
       VALUES ($1, $2, $3, 'reverse', $4, 'fp', 'system', NULL, 'welcome', NULL, NULL, '{}'::jsonb, now())`,
      [id, market_id, 'default', key_],
    ];
    const postingSql = (
      journalId: string,
      accountId: string,
      minor: bigint,
      market_id = mk,
    ): [string, unknown[]] => [
      `INSERT INTO wallet.postings (id, market_id, tenant_id, journal_id, account_id, amount_minor, currency, wallet_account_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, (SELECT wallet_account_id FROM wallet.journals WHERE market_id = $2::varchar AND id = $4::uuid))`,
      [ids.next(), market_id, 'default', journalId, accountId, minor, currency],
    ];
    /** One transaction of a journal with the given legs; the deferred constraint fires at COMMIT. */
    const writeJournal = async (legs: readonly [string, bigint][], market_id = mk) => {
      const journalId = ids.next<'WalletJournal'>();
      const client = new Client({ connectionString: testDatabaseUrl() });
      await client.connect();
      try {
        await client.query('BEGIN');
        await client.query(...journalSql(journalId, key('raw'), market_id));
        for (const [accountId, minor] of legs)
          await client.query(...postingSql(journalId, accountId, minor, market_id));
        await client.query('COMMIT');
        return journalId;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    };

    let scratchCount = 0;
    /**
     * A fresh scratch Market with the switch on and two internal accounts, for journals whose legs
     * are not customer wallets (a wallet's postings must agree with its balance and lots).
     */
    const scratch = async () => {
      const market_id = `${mk}${(scratchCount += 1)}`;
      await sql.query(
        `INSERT INTO wallet.market_settings (market_id, tenant_id, status, reason_code, updated_at, updated_by_account_id)
         VALUES ($1, 'default', 'active', NULL, now(), $2)`,
        [market_id, ids.next()],
      );
      const a = await accountRow('promo_expense', null, market_id);
      const b = await accountRow('refund_clearing', null, market_id);
      return { market_id, a, b };
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
      const { market_id: m, a, b } = await scratch();
      const write = (legs: readonly [string, bigint][]) => writeJournal(legs, m);
      await expect(
        write([
          [a, 500n],
          [b, -500n],
        ]),
      ).resolves.toBeDefined();
      expect(
        await code_(
          write([
            [a, 500n],
            [b, -400n],
          ]),
        ),
      ).toBe(CHECK);
      expect(await code_(write([[a, 500n]]))).toBe(CHECK);
      expect(await code_(write([]))).toBe(CHECK);
      expect(
        await code_(
          write([
            [a, 500n],
            [b, -300n],
            [a, -100n],
          ]),
        ),
      ).toBe(CHECK);
      // Three legs that do sum to zero are fine.
      await expect(
        write([
          [a, 500n],
          [b, -300n],
          [b, -200n],
        ]),
      ).resolves.toBeDefined();
      // A leg of zero is never written.
      expect(
        await code_(
          write([
            [a, 0n],
            [b, 0n],
          ]),
        ),
      ).toBe(CHECK);
    });

    it('never changes or removes a journal, a leg or a hold lot, for the application or the owner', async () => {
      const { market_id: m, a, b } = await scratch();
      const write = (legs: readonly [string, bigint][]) => writeJournal(legs, m);
      const journalId = await write([
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
      const { market_id: m, a, b: other } = await scratch();
      const wallet = await accountRow('credit_liability', customer, m);
      const bad = (available: bigint, held: bigint) =>
        sql.query(
          `INSERT INTO wallet.balances (wallet_account_id, market_id, tenant_id, currency, available_minor, held_minor, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, now())`,
          [wallet, m, 'default', currency, available, held],
        );
      expect(await code_(bad(-1n, 0n))).toBe(CHECK);
      expect(await code_(bad(0n, -1n))).toBe(CHECK);
      const journal = await writeJournal(
        [
          [a, -100n],
          [other, 100n],
        ],
        m,
      );
      const lot = (source: string, original: bigint, remaining: bigint, expires: string | null) =>
        probe([
          [
            `INSERT INTO wallet.lots (id, market_id, tenant_id, wallet_account_id, source, journal_id, original_minor, remaining_minor, currency, expires_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())`,
            [
              ids.next(),
              m,
              'default',
              wallet,
              source,
              journal,
              original,
              remaining,
              currency,
              expires,
            ],
          ],
        ]);
      expect(await lot('promo', 100n, 101n, '2027-01-01T00:00:00Z')).toBe(CHECK);
      expect(await lot('promo', 100n, -1n, '2027-01-01T00:00:00Z')).toBe(CHECK);
      expect(await lot('promo', 0n, 0n, '2027-01-01T00:00:00Z')).toBe(CHECK);
      expect(await lot('promo', 100n, 100n, null)).toBe(CHECK);
      expect(await lot('refund', 100n, 100n, '2027-01-01T00:00:00Z')).toBe(CHECK);
      expect(await lot('gift', 100n, 100n, null)).toBe(CHECK);
      expect(await lot('promo', 100n, 100n, '2027-01-01T00:00:00Z')).toBe('allowed');
      // Credit and holds expire after they are created (N10).
      expect(await lot('promo', 100n, 100n, '2020-01-01T00:00:00Z')).toBe(CHECK);
      const hold = (expires: string) =>
        probe([
          [
            `INSERT INTO wallet.holds (id, market_id, tenant_id, wallet_account_id, order_id, amount_minor, currency, status, expires_at, created_at)
             VALUES ($1, $2, 'default', $3, $4, 60, $5, 'held', now() + $6::interval, now())`,
            [ids.next(), m, wallet, ids.next(), currency, expires],
          ],
        ]);
      expect(await hold('0 seconds')).toBe(CHECK);
      expect(await hold('1 hour')).toBe('allowed');
      // A journal names its wallet unless it is a reversal, and its hold exactly for the three
      // hold kinds.
      const journal_ = (kind: string, walletId: string | null, holdId: string | null) =>
        probe([
          [
            `INSERT INTO wallet.journals (id, market_id, tenant_id, kind, idempotency_key, fingerprint, actor_kind, actor_id, reason_code, order_id, wallet_account_id, hold_id, result, created_at)
             VALUES ($1, $2, 'default', $3, $4, 'fp', 'system', NULL, 'welcome', NULL, $5, $6, '{}'::jsonb, now())`,
            [ids.next(), m, kind, key('n10'), walletId, holdId],
          ],
        ]);
      for (const kind of ['grant-promo', 'grant-refund', 'hold', 'capture', 'release', 'expire'])
        expect(
          await journal_(
            kind,
            null,
            kind.startsWith('grant') || kind === 'expire' ? null : ids.next(),
          ),
        ).toBe(CHECK);
      expect(await journal_('hold', wallet, null)).toBe(CHECK);
      expect(await journal_('grant-promo', wallet, ids.next())).toBe(CHECK);
      expect(await journal_('grant-promo', wallet, null)).toBe('allowed');
      expect(await journal_('release', wallet, ids.next())).toBe('allowed');
    });

    it('refuses a row that points at nothing, or at another Market, and a delete of a parent (composite foreign keys)', async () => {
      const wallet = await accountRow('credit_liability', ids.next<'Account'>());
      const other = await accountRow('order_clearing', null);
      const journal = await writeJournal([
        [other, -100n],
        [await accountRow('refund_clearing', null), 100n],
      ]);
      const FK = '23503';
      const ghost = ids.next();
      // A posting needs its journal and its account, in the same Market.
      expect(
        await code_(
          writeJournal([
            [ghost, 100n],
            [other, -100n],
          ]),
        ),
      ).toBe(FK);
      expect(
        await code_(
          sql.query(
            `INSERT INTO wallet.postings (id, market_id, tenant_id, journal_id, account_id, amount_minor, currency)
             VALUES ($1, $2, 'default', $3, $4, 5, $5)`,
            [ids.next(), mk, ghost, other, currency],
          ),
        ),
      ).toBe(FK);
      // Another Market's account id does not satisfy the Market-scoped key.
      expect(
        await code_(
          sql.query(
            `INSERT INTO wallet.lots (id, market_id, tenant_id, wallet_account_id, source, journal_id, original_minor, remaining_minor, currency, expires_at, created_at)
             VALUES ($1, $2, 'default', $3, 'refund', $4, 100, 100, $5, NULL, now())`,
            [ids.next(), `${mk}X`.slice(0, 8), wallet, journal, currency],
          ),
        ),
      ).toBe(RESTRICT); // the wallet guard looks the account up in the row's own Market first
      expect(
        await code_(
          sql.query(
            `INSERT INTO wallet.holds (id, market_id, tenant_id, wallet_account_id, order_id, amount_minor, currency, status, expires_at, created_at)
             VALUES ($1, $2, 'default', $3, $4, 60, $5, 'held', now() + interval '1 day', now())`,
            [ids.next(), mk, ghost, ids.next(), currency],
          ),
        ),
      ).toBe(RESTRICT);
      expect(
        await code_(
          sql.query(
            `INSERT INTO wallet.balances (wallet_account_id, market_id, tenant_id, currency, available_minor, held_minor, updated_at)
             VALUES ($1, $2, 'default', $3, 0, 0, now())`,
            [ghost, mk, currency],
          ),
        ),
      ).toBe(RESTRICT);
      // A lot, hold or balance of a real wallet in another currency fails the (Market, id,
      // currency) key; one on an internal account fails the wallet guard.
      const otherCurrency = currency === 'AUD' ? 'NZD' : 'AUD';
      const rowsFor = (account: string, currency_: string): [string, unknown[]][] => [
        [
          `INSERT INTO wallet.lots (id, market_id, tenant_id, wallet_account_id, source, journal_id, original_minor, remaining_minor, currency, expires_at, created_at)
           VALUES ($1, $2, 'default', $3, 'refund', $4, 100, 100, $5, NULL, now())`,
          [ids.next(), mk, account, journal, currency_],
        ],
        [
          `INSERT INTO wallet.holds (id, market_id, tenant_id, wallet_account_id, order_id, amount_minor, currency, status, expires_at, created_at)
           VALUES ($1, $2, 'default', $3, $4, 60, $5, 'held', now() + interval '1 day', now())`,
          [ids.next(), mk, account, ids.next(), currency_],
        ],
        [
          `INSERT INTO wallet.balances (wallet_account_id, market_id, tenant_id, currency, available_minor, held_minor, updated_at)
           VALUES ($1, $2, 'default', $3, 0, 0, now())`,
          [account, mk, currency_],
        ],
      ];
      for (const statement of rowsFor(wallet, otherCurrency))
        expect(await probe([statement])).toBe(FK);
      for (const statement of rowsFor(other, currency))
        expect(await probe([statement])).toBe(RESTRICT);
      expect(
        await code_(
          sql.query(
            `INSERT INTO wallet.hold_lots (hold_id, lot_id, market_id, tenant_id, amount_minor) VALUES ($1, $2, $3, 'default', 1)`,
            [ghost, ids.next(), mk],
          ),
        ),
      ).toBe(RESTRICT); // lots are written only with a hold created in the same transaction
      // A journal for a wallet that does not exist is refused; one for a real wallet is fine.
      expect(
        await code_(
          sql.query(
            `INSERT INTO wallet.journals (id, market_id, tenant_id, kind, idempotency_key, fingerprint, actor_kind, actor_id, reason_code, order_id, wallet_account_id, result, created_at)
             VALUES ($1, $2, 'default', 'reverse', $3, 'fp', 'system', NULL, 'welcome', NULL, $4, '{}'::jsonb, now())`,
            [ids.next(), mk, key('fk'), ghost],
          ),
        ),
      ).toBe(FK);
      // The owner cannot delete a parent that still has rows.
      expect(await code_(owner.query(`DELETE FROM wallet.journals WHERE id = $1`, [journal]))).toBe(
        RESTRICT,
      );
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

    it('keeps a single hold per order, per Market', async () => {
      const wallet = await accountRow('credit_liability', ids.next<'Account'>());
      const order = ids.next<'Order'>();
      const insertHold = (): [string, unknown[]] => [
        `INSERT INTO wallet.holds (id, market_id, tenant_id, wallet_account_id, order_id, amount_minor, currency, status, expires_at, created_at)
         VALUES ($1, $2, $3, $4, $5, 60, $6, 'held', now() + interval '1 day', now())`,
        [ids.next(), mk, 'default', wallet, order, currency],
      ];
      expect(await probe([insertHold()])).toBe('allowed');
      expect(await probe([insertHold(), insertHold()])).toBe(UNIQUE);
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
      expect(await code_(upsert(scratch, 'active', null))).toBe('allowed');
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
         VALUES ($1, $2, 'default', 'reverse', $3, 'fp', 'system', NULL, 'welcome', NULL, NULL, '{}'::jsonb, now())`,
        [journalId, scratch, key('scratch')],
      );
      for (const [accountId, minor] of [
        [legA, 1n],
        [legB, -1n],
      ] as const) {
        await client.query(
          `INSERT INTO wallet.postings (id, market_id, tenant_id, journal_id, account_id, amount_minor, currency, wallet_account_id)
           VALUES ($1, $2, 'default', $3, $4, $5, $6, NULL)`,
          [ids.next(), scratch, journalId, accountId, minor, currency],
        );
      }
      await client.query('COMMIT');
      await client.end();
      expect(await code_(upsert(scratch, 'off', null))).toBe(RESTRICT);
      expect(await code_(upsert(scratch, 'active', null))).toBe('allowed');
    });
  });

  // ---- the books at COMMIT, the row guards and the switch fence (raw SQL, scratch Markets) ----

  describe('books and fence', () => {
    type Statement = [string, unknown[]];
    const bk = `B${code}`;
    const url = testDatabaseUrl();

    const connect = async (connectionString: string = url) => {
      const client = new Client({ connectionString });
      await client.connect();
      return client;
    };
    /** The statements in one transaction, committed; the error of the first failure otherwise. */
    const commit = async (statements: readonly Statement[], connectionString: string = url) => {
      const client = await connect(connectionString);
      try {
        await client.query('BEGIN');
        for (const statement of statements) await client.query(...statement);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        await client.end();
      }
    };
    /** The same, always rolled back: the code of the first error or 'allowed' (row guards only). */
    const probe = async (statements: readonly Statement[], connectionString: string = url) => {
      const client = await connect(connectionString);
      try {
        await client.query('BEGIN');
        for (const statement of statements) await client.query(...statement);
        return 'allowed';
      } catch (error) {
        return (error as { code?: string }).code;
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
      }
    };

    const setting = (market_id: string, status: string): Statement => [
      `INSERT INTO wallet.market_settings (market_id, tenant_id, status, reason_code, updated_at, updated_by_account_id)
       VALUES ($1, 'default', $2, NULL, now(), $3) ON CONFLICT (market_id) DO NOTHING`,
      [market_id, status, ids.next()],
    ];
    const account = (
      market_id: string,
      id: string,
      kind: string,
      customer: string | null,
      cur = currency,
    ): Statement => [
      `INSERT INTO wallet.accounts (id, market_id, tenant_id, kind, customer_account_id, currency, status, created_at)
       VALUES ($1, $2, 'default', $3, $4, $5, 'active', now())`,
      [id, market_id, kind, customer, cur],
    ];
    const journal = (
      market_id: string,
      id: string,
      kind: string,
      wallet: string | null,
      order: string | null = null,
      holdId: string | null = null,
    ): Statement => [
      `INSERT INTO wallet.journals (id, market_id, tenant_id, kind, idempotency_key, fingerprint, actor_kind, actor_id, reason_code, order_id, wallet_account_id, hold_id, result, created_at)
       VALUES ($1, $2, 'default', $3, $4, 'fp', 'system', NULL, 'welcome', $5, $6, $7::uuid, jsonb_build_object('holdId', $7::text), now())`,
      [id, market_id, kind, key('raw'), order, wallet, holdId],
    ];
    const posting = (
      market_id: string,
      journalId: string,
      accountId: string,
      minor: bigint,
      cur = currency,
    ): Statement => [
      `INSERT INTO wallet.postings (id, market_id, tenant_id, journal_id, account_id, amount_minor, currency, wallet_account_id)
       VALUES ($1, $2, 'default', $3, $4, $5, $6, (SELECT wallet_account_id FROM wallet.journals WHERE market_id = $2::varchar AND id = $3::uuid))`,
      [ids.next(), market_id, journalId, accountId, minor, cur],
    ];
    const balance = (
      market_id: string,
      wallet: string,
      available: bigint,
      held: bigint,
    ): Statement => [
      `INSERT INTO wallet.balances (wallet_account_id, market_id, tenant_id, currency, available_minor, held_minor, updated_at)
       VALUES ($1, $2, 'default', $3, $4, $5, now())`,
      [wallet, market_id, currency, available, held],
    ];
    const setBalance = (wallet: string, available: bigint, held: bigint): Statement => [
      `UPDATE wallet.balances SET available_minor = $2, held_minor = $3 WHERE wallet_account_id = $1`,
      [wallet, available, held],
    ];
    const lot = (
      market_id: string,
      id: string,
      wallet: string,
      source: string,
      journalId: string,
      minor: bigint,
      expires: string | null,
    ): Statement => [
      `INSERT INTO wallet.lots (id, market_id, tenant_id, wallet_account_id, source, journal_id, original_minor, remaining_minor, currency, expires_at, created_at)
       VALUES ($1, $2, 'default', $3, $4, $5, $6, $6, $7, $8, LEAST(now(), $8::timestamptz - interval '1 day'))`,
      [id, market_id, wallet, source, journalId, minor, currency, expires],
    ];
    const setLot = (id: string, remaining: bigint): Statement => [
      `UPDATE wallet.lots SET remaining_minor = $2 WHERE id = $1`,
      [id, remaining],
    ];
    const holdRow = (
      market_id: string,
      id: string,
      wallet: string,
      order: string,
      minor: bigint,
    ): Statement => [
      `INSERT INTO wallet.holds (id, market_id, tenant_id, wallet_account_id, order_id, amount_minor, currency, status, expires_at, created_at)
       VALUES ($1, $2, 'default', $3, $4, $5, $6, 'held', now() + interval '1 day', now())`,
      [id, market_id, wallet, order, minor, currency],
    ];
    const holdLot = (market_id: string, hold: string, lotId: string, minor: bigint): Statement => [
      `INSERT INTO wallet.hold_lots (hold_id, lot_id, market_id, tenant_id, amount_minor) VALUES ($1, $2, $3, 'default', $4)`,
      [hold, lotId, market_id, minor],
    ];
    const settleHoldRow = (id: string, status: string): Statement => [
      `UPDATE wallet.holds SET status = $2, resolved_at = now() WHERE id = $1`,
      [id, status],
    ];

    /** A wallet with 100 of credit in one lot and a hold of 40 on it, all through journals. */
    const wallets = async (
      market_id: string,
      source: 'promo' | 'refund',
      expires: string | null,
    ) => {
      const w = {
        wallet: ids.next<'WalletAccount'>(),
        lot: ids.next<'WalletLot'>(),
        hold: ids.next<'WalletHold'>(),
        order: ids.next<'Order'>(),
        grant: ids.next<'WalletJournal'>(),
        placed: ids.next<'WalletJournal'>(),
      };
      const internal = await rows(
        `SELECT kind, id FROM wallet.accounts WHERE market_id = $1 AND customer_account_id IS NULL`,
        [market_id],
      );
      const idOfKind = (kind: string) => String(internal.find((r) => r.kind === kind)!.id);
      const origin = idOfKind(source === 'promo' ? 'promo_expense' : 'refund_clearing');
      const holdsAccount = idOfKind('holds');
      await commit([
        account(market_id, w.wallet, 'credit_liability', ids.next()),
        journal(market_id, w.grant, source === 'promo' ? 'grant-promo' : 'grant-refund', w.wallet),
        posting(market_id, w.grant, w.wallet, 100n),
        posting(market_id, w.grant, origin, -100n),
        balance(market_id, w.wallet, 100n, 0n),
        lot(market_id, w.lot, w.wallet, source, w.grant, 100n, expires),
      ]);
      await commit([
        journal(market_id, w.placed, 'hold', w.wallet, w.order, w.hold),
        posting(market_id, w.placed, w.wallet, -40n),
        posting(market_id, w.placed, holdsAccount, 40n),
        holdRow(market_id, w.hold, w.wallet, w.order, 40n),
        holdLot(market_id, w.hold, w.lot, 40n),
        setLot(w.lot, 60n),
        setBalance(w.wallet, 60n, 40n),
      ]);
      return { ...w, origin, holdsAccount, breakage: idOfKind('breakage_income') };
    };

    /** The statements of a release journal for the seeded hold. */
    const releaseOf = (market_id: string, w: Awaited<ReturnType<typeof wallets>>): Statement[] => {
      const id = ids.next<'WalletJournal'>();
      return [
        journal(market_id, id, 'release', w.wallet, w.order, w.hold),
        posting(market_id, id, w.holdsAccount, -40n),
        posting(market_id, id, w.wallet, 40n),
        settleHoldRow(w.hold, 'released'),
        setLot(w.lot, 100n),
        setBalance(w.wallet, 100n, 0n),
      ];
    };

    let plain: Awaited<ReturnType<typeof wallets>>;
    let expiring: Awaited<ReturnType<typeof wallets>>;
    const expiringMarket = `E${code}`;

    beforeAll(async () => {
      const internals = (market_id: string) => {
        const ids_ = [
          ids.next<'WalletAccount'>(),
          ids.next<'WalletAccount'>(),
          ids.next<'WalletAccount'>(),
        ] as const;
        return [
          setting(market_id, 'active'),
          account(market_id, ids_[0], 'refund_clearing', null),
          account(market_id, ids_[1], 'holds', null),
          account(market_id, ids_[2], 'breakage_income', null),
        ] satisfies Statement[];
      };
      await commit(internals(bk));
      plain = await wallets(bk, 'refund', null);
      const promo = internals(expiringMarket);
      promo[1] = account(expiringMarket, ids.next(), 'promo_expense', null);
      await commit(promo);
      expiring = await wallets(expiringMarket, 'promo', '2020-01-01T00:00:00Z');
    });

    it('refuses a direct UPDATE of a balance, a lot or a hold without its journal, at commit, as the application', async () => {
      const w = plain;
      // The balance zeroed or inflated.
      expect(await code_(commit([setBalance(w.wallet, 0n, 40n)]))).toBe(CHECK);
      expect(await code_(commit([setBalance(w.wallet, 49_999n, 40n)]))).toBe(CHECK);
      // A lot zeroed, with or without the balance following.
      expect(await code_(commit([setLot(w.lot, 0n)]))).toBe(CHECK);
      expect(await code_(commit([setLot(w.lot, 0n), setBalance(w.wallet, 0n, 40n)]))).toBe(CHECK);
      // A hold settled by hand: held credit gone with no ledger entry.
      expect(await code_(commit([settleHoldRow(w.hold, 'captured')]))).toBe(CHECK);
      // Even with the balance made to agree, a hold that leaves `held` needs its journal.
      const noJournal = await commit([
        settleHoldRow(w.hold, 'captured'),
        setBalance(w.wallet, 60n, 0n),
      ]).then(
        () => 'committed',
        (error: { code?: string; message?: string }) => `${error.code}: ${error.message}`,
      );
      expect(noJournal).toContain(CHECK);
      // The books are untouched by all of it.
      expect(
        await rows(
          `SELECT available_minor::text AS a, held_minor::text AS h FROM wallet.balances WHERE wallet_account_id = $1`,
          [w.wallet],
        ),
      ).toEqual([{ a: '60', h: '40' }]);
    });

    it('guards a lot, a hold and an account row by row', async () => {
      const w = plain;
      const owner_ = ownerTestDatabaseUrl();
      // A lot only decreases while a hold is held; and nothing but remaining_minor changes.
      expect(await probe([setLot(w.lot, 10n)])).toBe('allowed');
      expect(await probe([setLot(w.lot, 90n)])).toBe(RESTRICT);
      expect(
        await probe([[`UPDATE wallet.lots SET original_minor = 500 WHERE id = $1`, [w.lot]]]),
      ).toBe(NO_PRIVILEGE);
      expect(
        await probe([[`UPDATE wallet.lots SET source = 'promo' WHERE id = $1`, [w.lot]]], owner_),
      ).toBe(RESTRICT);
      // A settled hold gives credit back, once, and never changes again.
      expect(await probe([settleHoldRow(w.hold, 'released'), setLot(w.lot, 100n)])).toBe('allowed');
      expect(await probe([settleHoldRow(w.hold, 'released'), setLot(w.lot, 101n)])).toBe(RESTRICT);
      expect(
        await probe([settleHoldRow(w.hold, 'released'), settleHoldRow(w.hold, 'captured')]),
      ).toBe(RESTRICT);
      expect(
        await probe([[`UPDATE wallet.holds SET amount_minor = 1 WHERE id = $1`, [w.hold]]]),
      ).toBe(NO_PRIVILEGE);
      // An account freezes but a closed one never reopens, and nothing else about it changes.
      const statusOf = (status: string): Statement => [
        `UPDATE wallet.accounts SET status = $2 WHERE id = $1`,
        [w.wallet, status],
      ];
      expect(await probe([statusOf('frozen')])).toBe('allowed');
      expect(await probe([statusOf('closed'), statusOf('active')])).toBe(RESTRICT);
      expect(
        await probe(
          [[`UPDATE wallet.accounts SET kind = 'holds' WHERE id = $1`, [w.wallet]]],
          owner_,
        ),
      ).toBe(RESTRICT);
    });

    it('refuses a leg in another currency than its account or its journal', async () => {
      const w = plain;
      const id = ids.next<'WalletJournal'>();
      expect(
        await probe([
          journal(bk, id, 'release', w.wallet, w.order, w.hold),
          posting(bk, id, w.wallet, 5n, 'XXX'),
        ]),
      ).toBe(CHECK);
      expect(
        await probe([
          journal(bk, id, 'release', w.wallet, w.order, w.hold),
          posting(bk, id, w.wallet, 5n),
          posting(bk, id, w.holdsAccount, -5n, 'XXX'),
        ]),
      ).toBe(CHECK);
      expect(
        await probe([
          journal(bk, id, 'release', w.wallet, w.order, w.hold),
          posting(bk, id, w.wallet, 5n),
          posting(bk, id, w.holdsAccount, -5n),
        ]),
      ).toBe('allowed');
    });

    it('lets a hold release into an already-expired lot in the same transaction, and expired credit then never comes back', async () => {
      const w = expiring;
      const owner_ = ownerTestDatabaseUrl();
      // The promo lot expired in 2020: the release restores it, in the same transaction as the hold.
      await commit(releaseOf(expiringMarket, w));
      expect(
        await rows(`SELECT remaining_minor::text AS r FROM wallet.lots WHERE id = $1`, [w.lot]),
      ).toEqual([{ r: '100' }]);
      // The sweep expires it again: a journal to breakage income.
      const expire = ids.next<'WalletJournal'>();
      await commit([
        journal(expiringMarket, expire, 'expire', w.wallet),
        posting(expiringMarket, expire, w.wallet, -100n),
        posting(expiringMarket, expire, w.breakage, 100n),
        setLot(w.lot, 0n),
        setBalance(w.wallet, 0n, 0n),
      ]);
      // Credit that expired does not come back by an UPDATE, even though a hold of it was released.
      expect(await code_(commit([setLot(w.lot, 100n)]))).toBe(RESTRICT);
      expect(await code_(commit([setLot(w.lot, 100n), setBalance(w.wallet, 100n, 0n)]))).toBe(
        RESTRICT,
      );
      expect(
        await code_(commit([setLot(w.lot, 100n), setBalance(w.wallet, 100n, 0n)], owner_)),
      ).toBe(RESTRICT);
      expect(
        await rows(`SELECT remaining_minor::text AS r FROM wallet.lots WHERE id = $1`, [w.lot]),
      ).toEqual([{ r: '0' }]);
    });

    it('refuses a hold inserted already settled, with lots, a release journal and balance edits (the review reproduction)', async () => {
      const w = expiring; // its promo lot expired in 2020 and was moved to breakage income
      const order = ids.next<'Order'>();
      const hold = ids.next<'WalletHold'>();
      const journalId = ids.next<'WalletJournal'>();
      const attack: Statement[] = [
        [
          `INSERT INTO wallet.holds (id, market_id, tenant_id, wallet_account_id, order_id, amount_minor, currency, status, expires_at, created_at, resolved_at)
           VALUES ($1, $2, 'default', $3, $4, 100, $5, 'released', now() + interval '1 day', now(), now())`,
          [hold, expiringMarket, w.wallet, order, currency],
        ],
        holdLot(expiringMarket, hold, w.lot, 100n),
        journal(expiringMarket, journalId, 'release', w.wallet, order, hold),
        posting(expiringMarket, journalId, w.holdsAccount, -100n),
        posting(expiringMarket, journalId, w.wallet, 100n),
        setLot(w.lot, 100n),
        setBalance(w.wallet, 100n, 0n),
      ];
      expect(await code_(commit(attack))).toBe(RESTRICT);
      // Lots cannot be given to a hold that was not created in this transaction, either.
      expect(await code_(commit([holdLot(expiringMarket, w.hold, w.lot, 1n)]))).toBe(RESTRICT);
      // And the books are as they were.
      expect(
        await rows(`SELECT remaining_minor::text AS r FROM wallet.lots WHERE id = $1`, [w.lot]),
      ).toEqual([{ r: '0' }]);
    });

    it('refuses to settle a hold with a journal from an earlier transaction or of another hold, and a stray holds-account leg', async () => {
      // A held hold of 40 on a fresh wallet.
      const fresh = await wallets(bk, 'refund', null);
      const stray = ids.next<'WalletJournal'>();
      const other = ids.next<'WalletJournal'>();
      // A release journal that names another hold does not settle this one.
      const settleWith = (journalId: string, holdId: string | null): Statement[] => [
        journal(bk, journalId, 'release', fresh.wallet, fresh.order, holdId),
        posting(bk, journalId, fresh.holdsAccount, -40n),
        posting(bk, journalId, fresh.wallet, 40n),
        settleHoldRow(fresh.hold, 'released'),
        setLot(fresh.lot, 100n),
        setBalance(fresh.wallet, 100n, 0n),
      ];
      const named = await commit(settleWith(other, ids.next<'WalletHold'>())).then(
        () => 'committed',
        (error: Error) => error.message,
      );
      expect(named).toContain('left held without a released journal in this transaction');
      expect(await code_(commit(settleWith(stray, null)))).toBe(CHECK);
      // A leg on the holds account with no hold behind it breaks the wallet's books.
      const extra = ids.next<'WalletJournal'>();
      expect(
        await code_(
          commit([
            journal(bk, extra, 'hold', fresh.wallet, null, ids.next()),
            posting(bk, extra, fresh.holdsAccount, 5n),
            posting(bk, extra, fresh.wallet, -5n),
            setLot(fresh.lot, 55n),
            setBalance(fresh.wallet, 55n, 40n),
          ]),
        ),
      ).toBe(CHECK);
      // The honest settlement still commits.
      await commit(releaseOf(bk, fresh));
    });

    it('commits a legitimate release of a hold and then refuses a second settlement of it', async () => {
      const w = plain;
      await commit(releaseOf(bk, w));
      expect(await code_(commit([settleHoldRow(w.hold, 'captured')]))).toBe(RESTRICT);
      expect(
        await rows(
          `SELECT available_minor::text AS a, held_minor::text AS h FROM wallet.balances WHERE wallet_account_id = $1`,
          [w.wallet],
        ),
      ).toEqual([{ a: '100', h: '0' }]);
    });

    /**
     * Seeds $3 journals (half grants, half holds of one unit) over the customer wallets of Market $1
     * in currency $2, with their legs, lots, holds and hold lots, in one statement. Run by the owner
     * with the row triggers off: the rows are for query plans, not for the books.
     */
    const seedSql = `
      WITH w AS (
        SELECT id, row_number() OVER (ORDER BY id) - 1 AS n, count(*) OVER () AS total
          FROM wallet.accounts WHERE market_id = $1 AND kind = 'credit_liability'
      ), internal AS (
        SELECT (SELECT id FROM wallet.accounts WHERE market_id = $1 AND kind = 'holds') AS holds,
               (SELECT id FROM wallet.accounts WHERE market_id = $1 AND kind = 'refund_clearing') AS origin
      ), pairs AS (
        SELECT k, w.id AS wallet, gen_random_uuid() AS grant_j, gen_random_uuid() AS hold_j,
               gen_random_uuid() AS lot, gen_random_uuid() AS hold
          FROM generate_series(1, $3::int / 2) k JOIN w ON w.n = k % w.total
      ), ij AS (
        INSERT INTO wallet.journals (id, market_id, tenant_id, kind, idempotency_key, fingerprint, actor_kind, actor_id, reason_code, order_id, wallet_account_id, hold_id, result, created_at)
        SELECT grant_j, $1, 'default', 'grant-refund', 'seed:grant:' || k, 'fp', 'system', NULL::uuid, 'seed', NULL::uuid, wallet, NULL::uuid, '{}'::jsonb, now() FROM pairs
        UNION ALL
        SELECT hold_j, $1, 'default', 'hold', 'seed:hold:' || k, 'fp', 'system', NULL::uuid, 'seed', NULL::uuid, wallet, hold, '{}'::jsonb, now() FROM pairs
      ), ip AS (
        INSERT INTO wallet.postings (id, market_id, tenant_id, journal_id, account_id, amount_minor, currency, wallet_account_id)
        SELECT gen_random_uuid(), $1, 'default', grant_j, wallet, 2, $2, wallet FROM pairs
        UNION ALL SELECT gen_random_uuid(), $1, 'default', grant_j, internal.origin, -2, $2, wallet FROM pairs, internal
        UNION ALL SELECT gen_random_uuid(), $1, 'default', hold_j, wallet, -1, $2, wallet FROM pairs
        UNION ALL SELECT gen_random_uuid(), $1, 'default', hold_j, internal.holds, 1, $2, wallet FROM pairs, internal
      ), il AS (
        INSERT INTO wallet.lots (id, market_id, tenant_id, wallet_account_id, source, journal_id, original_minor, remaining_minor, currency, expires_at, created_at)
        SELECT lot, $1, 'default', wallet, 'refund', grant_j, 2, 1, $2, NULL::timestamptz, now() FROM pairs
      ), ih AS (
        INSERT INTO wallet.holds (id, market_id, tenant_id, wallet_account_id, order_id, amount_minor, currency, status, expires_at, created_at, resolved_at)
        SELECT hold, $1, 'default', wallet, gen_random_uuid(), 1, $2,
               CASE WHEN k % 4 = 0 THEN 'held' ELSE 'released' END, now() + interval '1 day', now(),
               CASE WHEN k % 4 = 0 THEN NULL ELSE now() END
          FROM pairs
      ), ib AS (
        INSERT INTO wallet.balances (wallet_account_id, market_id, tenant_id, currency, available_minor, held_minor, updated_at)
        SELECT id, $1, 'default', $2, 0, 0, now() FROM w
        ON CONFLICT DO NOTHING
      )
      INSERT INTO wallet.hold_lots (hold_id, lot_id, market_id, tenant_id, amount_minor)
      SELECT hold, lot, $1, 'default', 1 FROM pairs`;

    it('refuses a leg whose wallet differs from its journal, a wallet leg of another wallet and a holds leg of no wallet', async () => {
      const w = plain;
      const other = await wallets(bk, 'refund', null);
      const id = ids.next<'WalletJournal'>();
      const leg = (accountId: string, minor: bigint, wallet: string | null): Statement => [
        `INSERT INTO wallet.postings (id, market_id, tenant_id, journal_id, account_id, amount_minor, currency, wallet_account_id)
         VALUES ($1, $2, 'default', $3, $4, $5, $6, $7)`,
        [ids.next(), bk, id, accountId, minor, currency, wallet],
      ];
      const release = journal(bk, id, 'release', w.wallet, w.order, w.hold);
      expect(await probe([release, leg(w.holdsAccount, -5n, null)])).toBe(CHECK);
      expect(await probe([release, leg(w.holdsAccount, -5n, other.wallet)])).toBe(CHECK);
      expect(await probe([release, leg(other.wallet, 5n, w.wallet)])).toBe(CHECK);
      const reversal = journal(bk, id, 'reverse', null);
      expect(await probe([reversal, leg(w.holdsAccount, -5n, null)])).toBe(CHECK);
      expect(await probe([release, leg(w.holdsAccount, -5n, w.wallet)])).toBe('allowed');
    });

    it('refuses hold lots written inside a savepoint: wallet units must not use savepoints', async () => {
      const w = await wallets(bk, 'refund', null);
      const hold = ids.next<'WalletHold'>();
      const order = ids.next<'Order'>();
      const placed = ids.next<'WalletJournal'>();
      const place: Statement[] = [
        journal(bk, placed, 'hold', w.wallet, order, hold),
        posting(bk, placed, w.wallet, -10n),
        posting(bk, placed, w.holdsAccount, 10n),
        holdRow(bk, hold, w.wallet, order, 10n),
        holdLot(bk, hold, w.lot, 10n),
      ];
      expect(await probe(place)).toBe('allowed');
      // The hold row written inside a savepoint carries the subtransaction id, not the
      // transaction's, so the "same transaction" test fails closed.
      expect(await probe([['SAVEPOINT unit', []], ...place])).toBe(RESTRICT);
      expect(await probe([...place.slice(0, 4), ['SAVEPOINT unit', []], place[4]!])).toBe(
        'allowed',
      );
    });

    it('lets a lock-only update of a balance commit without checking the books again', async () => {
      const w = await wallets(bk, 'refund', null);
      const lockOnly: Statement = [
        `UPDATE wallet.balances SET available_minor = available_minor + 0, updated_at = updated_at WHERE market_id = $1 AND wallet_account_id = $2`,
        [bk, w.wallet],
      ];
      // The owner drifts the balance with the check switched off; the check is then on again.
      await owner.query('BEGIN');
      await owner.query(`ALTER TABLE wallet.balances DISABLE TRIGGER balances_books_update`);
      await owner.query(
        `UPDATE wallet.balances SET available_minor = available_minor + 1 WHERE wallet_account_id = $1`,
        [w.wallet],
      );
      await owner.query(`ALTER TABLE wallet.balances ENABLE TRIGGER balances_books_update`);
      await owner.query('COMMIT');
      try {
        // A row that does not change queues no books check, so the drift does not block it ...
        expect(await code_(commit([lockOnly]))).toBe('allowed');
        // ... while a row that changes is checked, and the drift is caught.
        expect(await code_(commit([setBalance(w.wallet, 61n, 39n)]))).toBe(CHECK);
      } finally {
        await owner.query('BEGIN');
        await owner.query(`ALTER TABLE wallet.balances DISABLE TRIGGER balances_books_update`);
        await owner.query(
          `UPDATE wallet.balances SET available_minor = available_minor - 1 WHERE wallet_account_id = $1`,
          [w.wallet],
        );
        await owner.query(`ALTER TABLE wallet.balances ENABLE TRIGGER balances_books_update`);
        await owner.query('COMMIT');
      }
      expect(
        await rows(
          `SELECT available_minor::text AS a, held_minor::text AS h FROM wallet.balances WHERE wallet_account_id = $1`,
          [w.wallet],
        ),
      ).toEqual([{ a: '60', h: '40' }]);
    });

    it('reaches postings, hold lots and journals in the ledger checks through a Market-scoped index, never a full scan', async () => {
      // A modest ledger in a Market of its own, seeded by the owner with the row checks off.
      const seeded = `X${code}`;
      const tables = ['journals', 'postings', 'lots', 'holds', 'hold_lots', 'balances'];
      await owner.query('BEGIN');
      try {
        for (const table of tables)
          await owner.query(`ALTER TABLE wallet.${table} DISABLE TRIGGER USER`);
        await owner.query(
          `INSERT INTO wallet.accounts (id, market_id, tenant_id, kind, customer_account_id, currency, status, created_at)
           SELECT gen_random_uuid(), $1, 'default', 'credit_liability', gen_random_uuid(), $2, 'active', now()
             FROM generate_series(1, 100)
           UNION ALL SELECT gen_random_uuid(), $1, 'default', 'holds', NULL, $2, 'active', now()
           UNION ALL SELECT gen_random_uuid(), $1, 'default', 'refund_clearing', NULL, $2, 'active', now()`,
          [seeded, currency],
        );
        await owner.query(seedSql, [seeded, currency, 10_000]);
        for (const table of tables)
          await owner.query(`ALTER TABLE wallet.${table} ENABLE TRIGGER USER`);
        await owner.query('COMMIT');
      } catch (error) {
        await owner.query('ROLLBACK');
        throw error;
      }
      for (const table of [...tables, 'accounts']) await owner.query(`ANALYZE wallet.${table}`);
      const [sample] = await rows(
        `SELECT j.id AS journal, j.wallet_account_id AS wallet, j.hold_id AS hold, hl.lot_id AS lot,
                (SELECT id FROM wallet.accounts WHERE market_id = $1 AND kind = 'holds') AS holds
           FROM wallet.journals j JOIN wallet.hold_lots hl ON hl.market_id = j.market_id AND hl.hold_id = j.hold_id
          WHERE j.market_id = $1 LIMIT 1`,
        [seeded],
      );
      // The statements of the ledger triggers (check_journal_balanced, guard_posting_insert,
      // guard_lot_update, check_wallet_books, check_hold_settled), with their parameters.
      const statements: [string, string, unknown[]][] = [
        [
          'balanced',
          `SELECT COALESCE(SUM(amount_minor), 0), COUNT(*) FROM wallet.postings WHERE market_id = $1 AND journal_id = $2`,
          [seeded, sample!.journal],
        ],
        [
          'leg currency',
          `SELECT 1 FROM wallet.postings p WHERE p.market_id = $1 AND p.journal_id = $2 AND p.currency <> $3`,
          [seeded, sample!.journal, currency],
        ],
        [
          'lot restore',
          `SELECT COALESCE(SUM(hl.amount_minor), 0) FROM wallet.hold_lots hl JOIN wallet.holds h
              ON h.market_id = hl.market_id AND h.id = hl.hold_id
           WHERE hl.market_id = $1 AND hl.lot_id = $2 AND h.status IN ('held', 'captured')`,
          [seeded, sample!.lot],
        ],
        [
          'posted',
          `SELECT COALESCE(SUM(p.amount_minor), 0) FROM wallet.postings p
            WHERE p.market_id = $1 AND p.wallet_account_id = $2 AND p.account_id = $2`,
          [seeded, sample!.wallet],
        ],
        [
          'holds account',
          `SELECT COALESCE(SUM(p.amount_minor), 0) FROM wallet.postings p
            WHERE p.market_id = $1 AND p.wallet_account_id = $2 AND p.account_id = $3`,
          [seeded, sample!.wallet, sample!.holds],
        ],
        [
          'hold settled',
          `SELECT 1 FROM wallet.journals j WHERE j.market_id = $1 AND j.hold_id = $2 AND j.kind = 'release'`,
          [seeded, sample!.hold],
        ],
      ];
      type PlanNode = {
        'Node Type': string;
        'Relation Name'?: string;
        'Index Name'?: string;
        'Index Cond'?: string;
        Plans?: PlanNode[];
      };
      const scans = (node: PlanNode): PlanNode[] => [node, ...(node.Plans ?? []).flatMap(scans)];
      const guarded = /^(postings|hold_lots|journals)/;
      const client = await connect();
      try {
        // Custom plans (literal parameters) and the generic plan PL/pgSQL settles on.
        for (const mode of ['force_custom_plan', 'force_generic_plan']) {
          await client.query(`SET plan_cache_mode = ${mode}`);
          for (const [name, text, values] of statements) {
            await client.query(`PREPARE probe_plan AS ${text}`);
            const literals = values.map((value) => client.escapeLiteral(String(value))).join(', ');
            const { rows: plan } = await client.query<{ 'QUERY PLAN': [{ Plan: PlanNode }] }>(
              `EXPLAIN (FORMAT JSON) EXECUTE probe_plan(${literals})`,
            );
            await client.query('DEALLOCATE probe_plan');
            const nodes = scans(plan[0]!['QUERY PLAN'][0].Plan);
            const touched = nodes.filter(
              (n) => guarded.test(n['Relation Name'] ?? '') || guarded.test(n['Index Name'] ?? ''),
            );
            expect({
              name,
              mode,
              seq: touched.filter((n) => n['Node Type'] === 'Seq Scan'),
            }).toEqual({ name, mode, seq: [] });
            const conditions = touched.flatMap((n) => (n['Index Cond'] ? [n['Index Cond']] : []));
            expect({
              name,
              mode,
              scoped: conditions.length > 0 && conditions.every((c) => c.includes('market_id')),
            }).toEqual({ name, mode, scoped: true });
          }
        }
      } finally {
        await client.end();
      }
    });

    // ---- the switch fence ----------------------------------------------------------------

    /** True while the promise is still waiting after a short pause. */
    const stillWaiting = async (promise: Promise<unknown>) => {
      const marker = Symbol('waiting');
      const first = await Promise.race([
        promise.then(
          () => 'done',
          () => 'done',
        ),
        new Promise((resolve) => setTimeout(() => resolve(marker), 400)),
      ]);
      return first === marker;
    };
    const fenceMarket = async (
      suffix: string,
      internalKinds: readonly string[] = ['promo_expense', 'refund_clearing'],
    ) => {
      const market_id = `${suffix}${code}`;
      const accountIds = internalKinds.map(() => ids.next<'WalletAccount'>());
      const w = ids.next<'WalletAccount'>();
      await commit([
        setting(market_id, 'active'),
        ...internalKinds.map((kind, index) => account(market_id, accountIds[index]!, kind, null)),
        account(market_id, w, 'credit_liability', ids.next()),
      ]);
      return { market_id, a: accountIds[0]!, b: accountIds[1]!, w };
    };
    /**
     * A balanced journal of the given kind between two internal accounts. It names the Market's
     * wallet (its books stay at zero) unless it is a reversal, and a hold for the hold kinds.
     */
    const grantStatements = (
      m: { market_id: string; a: string; b: string; w: string },
      kind = 'grant-promo',
    ): Statement[] => {
      const id = ids.next<'WalletJournal'>();
      const holdId = ['hold', 'capture', 'release'].includes(kind) ? ids.next() : null;
      return [
        journal(m.market_id, id, kind, kind === 'reverse' ? null : m.w, null, holdId),
        posting(m.market_id, id, m.a, 1n),
        posting(m.market_id, id, m.b, -1n),
      ];
    };
    const statusUpdate = (market_id: string, status: string): Statement => [
      `UPDATE wallet.market_settings SET status = $2, reason_code = $3, updated_at = now() WHERE market_id = $1`,
      [market_id, status, status === 'frozen' || status === 'paused' ? 'maintenance' : null],
    ];
    const open = async (statements: readonly Statement[]) => {
      const client = await connect();
      try {
        await client.query('BEGIN');
        for (const statement of statements) await client.query(...statement);
        return client;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        await client.end();
        throw error;
      }
    };

    it('a freeze waits for a journal in flight, and a journal in flight waits for the freeze and is then refused', async () => {
      const m = await fenceMarket('F');
      // A journal is in flight (it has read the status FOR SHARE): the freeze queues behind it.
      const inFlight = await open(grantStatements(m));
      const freeze = code_(commit([statusUpdate(m.market_id, 'frozen')]));
      expect(await stillWaiting(freeze)).toBe(true);
      await inFlight.query('COMMIT');
      await inFlight.end();
      expect(await freeze).toBe('allowed');
      // Frozen: new work is refused by the database, release and expiry still go through.
      expect(await code_(commit(grantStatements(m)))).toBe(RESTRICT);
      expect(await code_(commit(grantStatements(m, 'hold')))).toBe(RESTRICT);
      expect(await code_(commit(grantStatements(m, 'capture')))).toBe(RESTRICT);
      expect(await code_(commit(grantStatements(m, 'release')))).toBe('allowed');
      expect(await code_(commit(grantStatements(m, 'expire')))).toBe('allowed');
      // The other way round: the freeze is in flight, a journal waits for it and is refused.
      await commit([statusUpdate(m.market_id, 'active')]);
      const freezing = await open([statusUpdate(m.market_id, 'frozen')]);
      const late = open(grantStatements(m)).then(
        async (client) => {
          await client.end();
          return 'allowed';
        },
        (error: { code?: string }) => error.code,
      );
      expect(await stillWaiting(late)).toBe(true);
      await freezing.query('COMMIT');
      await freezing.end();
      expect(await late).toBe(RESTRICT);
    });

    it('paused allows capture, release and expiry but no grant or hold; off allows nothing', async () => {
      const m = await fenceMarket('P');
      await commit([statusUpdate(m.market_id, 'paused')]);
      expect(await code_(commit(grantStatements(m, 'grant-refund')))).toBe(RESTRICT);
      expect(await code_(commit(grantStatements(m, 'hold')))).toBe(RESTRICT);
      expect(await code_(commit(grantStatements(m, 'reverse')))).toBe(RESTRICT);
      for (const kind of ['capture', 'release', 'expire']) {
        expect(await code_(commit(grantStatements(m, kind)))).toBe('allowed');
      }
      // No settings row at all is `off`.
      const none = `N${code}`;
      const noneAccounts = [
        ids.next<'WalletAccount'>(),
        ids.next<'WalletAccount'>(),
        ids.next<'WalletAccount'>(),
      ];
      await commit([
        account(none, noneAccounts[0]!, 'promo_expense', null),
        account(none, noneAccounts[1]!, 'refund_clearing', null),
        account(none, noneAccounts[2]!, 'credit_liability', ids.next()),
      ]);
      expect(
        await code_(
          commit(
            grantStatements(
              { market_id: none, a: noneAccounts[0]!, b: noneAccounts[1]!, w: noneAccounts[2]! },
              'release',
            ),
          ),
        ),
      ).toBe(RESTRICT);
    });

    it('never goes back to off with history, whichever of the two transactions comes first', async () => {
      // The first journal is in flight when the Market is turned off: the switch waits, then sees it.
      const m1 = await fenceMarket('G');
      const first = await open(grantStatements(m1));
      const turnOff = code_(commit([statusUpdate(m1.market_id, 'off')]));
      expect(await stillWaiting(turnOff)).toBe(true);
      await first.query('COMMIT');
      await first.end();
      expect(await turnOff).toBe(RESTRICT);
      expect(
        await rows(`SELECT status FROM wallet.market_settings WHERE market_id = $1`, [
          m1.market_id,
        ]),
      ).toEqual([{ status: 'active' }]);
      // The switch to off is in flight (no journal yet): the first journal waits, then is refused.
      const m2 = await fenceMarket('H');
      const switching = await open([statusUpdate(m2.market_id, 'off')]);
      const firstJournal = open(grantStatements(m2)).then(
        async (client) => {
          await client.end();
          return 'allowed';
        },
        (error: { code?: string }) => error.code,
      );
      expect(await stillWaiting(firstJournal)).toBe(true);
      await switching.query('COMMIT');
      await switching.end();
      expect(await firstJournal).toBe(RESTRICT);
      expect(
        await rows(`SELECT count(*)::int AS n FROM wallet.journals WHERE market_id = $1`, [
          m2.market_id,
        ]),
      ).toEqual([{ n: 0 }]);
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
      // Two first PUTs at once queue on the seeded row; neither fails.
      const firstPuts = await Promise.all([turn('active'), turn('active')]);
      expect(firstPuts.every((r) => r.ok)).toBe(true);
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

  // ---- the books agree after every step ------------------------------------------------------

  describe('ledger invariants', () => {
    const sweep = () => new ExpireWalletCredit(gate, deps).execute(system, {});
    const num = (value: unknown) => BigInt(typeof value === 'string' ? value : '0');
    const reconcile = () =>
      deps.unitOfWork.run<readonly unknown[], never>(
        market,
        async () => ok(await deps.wallet.reconcile(market)),
        { readOnly: true },
      );

    /** The same checks as `reconcile`, written as plain SQL so the two can be compared. */
    const assertBooks = async (step: string, customers: readonly Id<'Account'>[]) => {
      const where = `step "${step}"`;
      for (const customer of customers) {
        const [row] = await rows(
          `SELECT a.id,
                  b.available_minor::text AS available,
                  b.held_minor::text AS held,
                  (SELECT COALESCE(sum(amount_minor), 0) FROM wallet.postings WHERE account_id = a.id)::text AS posted,
                  (SELECT COALESCE(sum(remaining_minor), 0) FROM wallet.lots WHERE wallet_account_id = a.id)::text AS lotted,
                  (SELECT COALESCE(sum(amount_minor), 0) FROM wallet.holds WHERE wallet_account_id = a.id AND status = 'held')::text AS holding
             FROM wallet.accounts a JOIN wallet.balances b ON b.wallet_account_id = a.id
            WHERE a.market_id = $1 AND a.customer_account_id = $2`,
          [market.marketId, customer],
        );
        if (row === undefined) continue; // the wallet is created by its first grant
        expect({ where, ...row }).toMatchObject({
          posted: row.available,
          lotted: row.available,
          holding: row.held,
        });
      }
      const unbalanced = await rows(
        `SELECT journal_id FROM wallet.postings WHERE market_id = $1 GROUP BY journal_id HAVING sum(amount_minor) <> 0`,
        [market.marketId],
      );
      expect({ where, unbalanced }).toEqual({ where, unbalanced: [] });
      const [holds] = await rows(
        `SELECT (SELECT COALESCE(sum(p.amount_minor), 0) FROM wallet.postings p JOIN wallet.accounts a ON a.id = p.account_id
                  WHERE a.market_id = $1 AND a.kind = 'holds')::text AS account,
                (SELECT COALESCE(sum(amount_minor), 0) FROM wallet.holds WHERE market_id = $1 AND status = 'held')::text AS held`,
        [market.marketId],
      );
      expect({ where, account: num(holds!.account) }).toEqual({ where, account: num(holds!.held) });
      expect({ where, mismatches: await reconcile() }).toEqual({
        where,
        mismatches: ok([]),
      });
    };

    it('postings, lots, holds and balances agree after every step of a mixed sequence on two wallets', async () => {
      expect((await turn('active')).ok).toBe(true);
      const a = ids.next<'Account'>();
      const b = ids.next<'Account'>();
      const both = [a, b] as const;
      const [a1, a2, a3, b1] = [1, 2, 3, 4].map(() => ids.next<'Order'>()) as [
        Id<'Order'>,
        Id<'Order'>,
        Id<'Order'>,
        Id<'Order'>,
      ];
      const ok_ = <T>(r: { ok: boolean } & T) => expect(r.ok).toBe(true);
      const afterLotExpiryHours = 24 * 31 * promoMonths;

      ok_(await grant(a, 600n, 'promo'));
      await assertBooks('grant promo A', both);
      ok_(await grant(a, 400n, 'refund'));
      await assertBooks('grant refund A', both);
      ok_(await grant(b, 300n, 'promo'));
      ok_(await grant(b, 200n, 'refund'));
      await assertBooks('grants on B', both);

      ok_(await hold(a, a1, 300n, 1));
      await assertBooks('hold A a1', both);
      ok_(await hold(a, a2, 200n, 24));
      await assertBooks('hold A a2', both);
      ok_(await settle('capture', a, a2));
      await assertBooks('capture A a2', both);
      ok_(await settle('release', a, a1));
      await assertBooks('release A a1', both);

      // A hold that runs out: the sweep gives it back.
      ok_(await hold(a, a3, 150n, 1));
      ok_(await hold(b, b1, 250n, afterLotExpiryHours + 24 * 5));
      await assertBooks('holds A a3 and B b1', both);
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      expect(await sweep()).toMatchObject({ ok: true, value: { expiredHolds: 1, failed: [] } });
      await assertBooks('hold expiry of a3', both);

      // The promo lots run out while b1 still holds 250 of B's promo lot.
      clock.advance(Temporal.Duration.from({ hours: afterLotExpiryHours }));
      expect(await sweep()).toMatchObject({ ok: true, value: { failed: [] } });
      await assertBooks('lot expiry', both);
      expect(await balanceOf(b)).toEqual([200n, 250n]);

      // b1 is released into a lot that is already expired; the next sweep expires it again.
      ok_(await settle('release', b, b1));
      expect(await balanceOf(b)).toEqual([450n, 0n]);
      await assertBooks('release into an expired lot', both);
      const again = await sweep();
      expect(again).toMatchObject({ ok: true, value: { expiredLots: 1, failed: [] } });
      expect(await balanceOf(b)).toEqual([200n, 0n]);
      await assertBooks('re-expiry', both);
      expect(await balanceOf(a)).toEqual([400n, 0n]);
    });

    it('a freeze racing a grant never fails: the grant commits before it or is refused', async () => {
      for (let round = 0; round < 5; round += 1) {
        expect((await turn('active')).ok).toBe(true);
        const customer = ids.next<'Account'>();
        const [granted, frozen] = await Promise.all([
          grant(customer, 10n),
          turn('frozen', 'maintenance'),
        ]);
        expect(frozen.ok).toBe(true);
        expect(granted.ok || granted.error.code === 'wallet.frozen').toBe(true);
        expect(await grant(customer, 10n)).toEqual(err({ code: 'wallet.frozen' }));
      }
      expect((await turn('active')).ok).toBe(true);
      expect(await reconcile()).toEqual(ok([]));
    });

    it('gives up after 3 s when journals in flight hold the switch, and answers wallet.busy', async () => {
      expect((await turn('active')).ok).toBe(true);
      const inFlight = new Client({ connectionString: testDatabaseUrl() });
      await inFlight.connect();
      try {
        await inFlight.query('BEGIN');
        await inFlight.query(
          `SELECT 1 FROM wallet.market_settings WHERE market_id = $1 FOR SHARE`,
          [market.marketId],
        );
        const started = Date.now();
        expect(await turn('paused', 'maintenance')).toEqual(err({ code: 'wallet.busy' }));
        expect(Date.now() - started).toBeGreaterThanOrEqual(2500);
      } finally {
        await inFlight.query('ROLLBACK').catch(() => undefined);
        await inFlight.end();
      }
      expect((await turn('paused', 'maintenance')).ok).toBe(true);
      expect((await turn('active')).ok).toBe(true);
    });

    it('two requests with one key for different customers: one wins, the other is told the key is taken', async () => {
      const shared = key('shared');
      const results = await Promise.all([
        grant(ids.next<'Account'>(), 50n, 'promo', shared),
        grant(ids.next<'Account'>(), 50n, 'promo', shared),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.find((r) => !r.ok)).toEqual(err({ code: 'idempotency.key-reused' }));
      expect(await reconcile()).toEqual(ok([]));
    });

    it('refuses to capture a hold past its expiry; the sweep then releases it', async () => {
      expect((await turn('active')).ok).toBe(true);
      const customer = ids.next<'Account'>();
      await grant(customer, 300n, 'refund');
      const order = ids.next<'Order'>();
      expect((await hold(customer, order, 100n, 1)).ok).toBe(true);
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      expect(await settle('capture', customer, order)).toEqual(
        err({ code: 'wallet.hold-expired' }),
      );
      expect(await sweep()).toMatchObject({ ok: true, value: { failed: [] } });
      expect(await settle('capture', customer, order)).toEqual(
        err({ code: 'wallet.hold-not-held' }),
      );
      expect(await balanceOf(customer)).toEqual([300n, 0n]);
    });

    it('reports a balance that drifted from the postings, and nothing once it is put back', async () => {
      const customer = ids.next<'Account'>();
      await grant(customer, 100n, 'refund');
      expect(await reconcile()).toEqual(ok([]));
      const wallet = `(SELECT id FROM wallet.accounts WHERE market_id = $1 AND customer_account_id = $2)`;
      // The commit-time check refuses such a drift, so it is let through for this test only, by
      // the owner switching the check off around it.
      await owner.query(`ALTER TABLE wallet.balances DISABLE TRIGGER balances_books_update`);
      try {
        await owner.query(
          `UPDATE wallet.balances SET available_minor = available_minor + 7 WHERE wallet_account_id = ${wallet}`,
          [market.marketId, customer],
        );
        const drift = await reconcile();
        expect(drift.ok && drift.value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              check: 'postings-vs-available',
              expected: 107n,
              actual: 100n,
            }),
            expect.objectContaining({ check: 'lots-vs-available', expected: 107n, actual: 100n }),
          ]),
        );
        await owner.query(
          `UPDATE wallet.balances SET available_minor = available_minor - 7 WHERE wallet_account_id = ${wallet}`,
          [market.marketId, customer],
        );
      } finally {
        await owner.query(`ALTER TABLE wallet.balances ENABLE TRIGGER balances_books_update`);
      }
      expect(await reconcile()).toEqual(ok([]));
    });
  });
});
