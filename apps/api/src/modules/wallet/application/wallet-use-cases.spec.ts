import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { MemoryMarketSetting, MemoryWallet } from '../../../../test/support/wallet-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { TransactionConflictError } from '../../../platform/unit-of-work/errors';
import { WALLET_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigWalletPolicy } from '../infrastructure/config-wallet-policy';
import { WalletFacadeImplementation } from '../presentation/wallet.facade';
import { viewMyWallet } from './customer-flow';
import { setStatus } from './settings-flow';
import { AdminBalanceOf } from './use-cases/admin-balance-of.use-case';
import { BalanceOf } from './use-cases/balance-of.use-case';
import { OwnBalanceOf } from './use-cases/own-balance-of.use-case';
import { CaptureHold } from './use-cases/capture-hold.use-case';
import { ExpireWalletCredit } from './use-cases/expire-wallet-credit.use-case';
import { GrantCredit } from './use-cases/grant-credit.use-case';
import { PlaceHold } from './use-cases/place-hold.use-case';
import { ReleaseHold } from './use-cases/release-hold.use-case';
import { SetWalletStatus } from './use-cases/set-wallet-status.use-case';
import { ViewMyHistory } from './use-cases/view-my-history.use-case';
import { ViewMyWallet } from './use-cases/view-my-wallet.use-case';
import { ViewWalletSettings } from './use-cases/view-wallet-settings.use-case';
import type { WalletDependencies } from './wallet-dependencies';

// The wallet ledger core in memory on both Market fixtures (AU: AUD, cap 500.00, promo 12 months;
// ZZ: JPY, cap 30000, promo 6 months): the switch (off by default; off, active, paused, frozen),
// grants within the cap, lots spent soonest-expiring first, holds, capture, release, the expiry
// sweeps and the hard rules of the switch. The tables' own guards have their database spec.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const OTHER_CUSTOMER = id<'Account'>(0xc2);
const ADMIN = id<'Account'>(0xad);
const ADMIN_SESSION = id<'Session'>(0x62);
const ORDER_1 = id<'Order'>(0x101);
const ORDER_2 = id<'Order'>(0x102);

const ACTIONS = new Set<string>(WALLET_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('wallet ledger core in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const config = markets.get(market.marketId);
  const currency = config.defaultCurrency;
  const cap = BigInt(config.wallet!.balanceCapMinor);
  const promoMonths = config.wallet!.promoExpiryMonths;
  const amount = (minor: bigint) => money(minor, currency);

  let clock: FixedClock;
  let denyKeys: boolean;
  let gate: ReturnType<typeof createUseCaseGate>;
  let wallet: MemoryWallet;
  let setting: MemoryMarketSetting;
  let audit: RecordingAudit;
  let deps: WalletDependencies;
  let seq = 0;
  // identity's spend of the admin step-up proof (issue #491): a proof unless a test says otherwise.
  let stepUpAnswer: Awaited<ReturnType<WalletDependencies['stepUp']['consume']>>;
  let stepUpAsked: string[];

  const customerCtx = (accountId = CUSTOMER) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'customer',
        accountId,
        sessionId: id<'Session'>(0x61),
        sellerId: null,
      }),
      'wallet-customer-abcd',
    );
  const adminCtx = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: ADMIN_SESSION,
        sellerId: null,
      }),
      'wallet-admin-abcd',
    );
  const system = testCallContext(market, 'system', 'wallet-system-abcd');

  beforeEach(() => {
    seq = 0;
    clock = new FixedClock(T0);
    denyKeys = false;
    gate = createUseCaseGate(markets, {
      check: (): Promise<AccessDecision> =>
        Promise.resolve(
          denyKeys ? { allowed: false, denial: { code: 'access.denied' } } : { allowed: true },
        ),
    });
    wallet = new MemoryWallet();
    setting = new MemoryMarketSetting();
    audit = new RecordingAudit();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      wallet,
      settings: setting,
      policy: new ConfigWalletPolicy(markets),
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
      stepUp: {
        consume: (_context, actionKey) => {
          stepUpAsked.push(actionKey);
          return Promise.resolve(stepUpAnswer);
        },
      },
    };
    stepUpAnswer = ok({ sessionId: ADMIN_SESSION, verifiedAt: T0 });
    stepUpAsked = [];
  });

  const key = (label: string) => `${label}-${(seq += 1)}`.padEnd(8, '0');
  // The admin's tab is fresh unless a test says otherwise: the version it sends is the current one.
  const turn = (
    status: string,
    reasonCode?: string,
    context = adminCtx(),
    expectedVersion: unknown = setting.record?.version ?? 0,
  ) => new SetWalletStatus(gate, deps).execute(context, { status, reasonCode, expectedVersion });
  const open = async (status: 'active' | 'paused' | 'frozen' = 'active') => {
    const result = await turn(status, status === 'active' ? undefined : 'maintenance');
    expect(result.ok).toBe(true);
  };
  const grant = (
    minor: bigint,
    source: 'promo' | 'refund' = 'promo',
    idempotencyKey = key('grant'),
    customerAccountId = CUSTOMER,
  ) =>
    new GrantCredit(gate, deps).execute(system, {
      customerAccountId,
      source,
      amount: amount(minor),
      reasonCode: 'welcome',
      idempotencyKey,
    });
  const hold = (
    minor: bigint,
    orderId = ORDER_1,
    idempotencyKey = key('hold'),
    expiresInHours = 2,
  ) =>
    new PlaceHold(gate, deps).execute(system, {
      customerAccountId: CUSTOMER,
      orderId,
      amount: amount(minor),
      expiresAt: clock.now().add({ hours: expiresInHours }),
      idempotencyKey,
    });
  const settle = (what: 'capture' | 'release', orderId = ORDER_1, idempotencyKey = key(what)) => {
    const useCase = what === 'capture' ? new CaptureHold(gate, deps) : new ReleaseHold(gate, deps);
    return useCase.execute(system, { customerAccountId: CUSTOMER, orderId, idempotencyKey });
  };
  const balance = async () => {
    const result = await new BalanceOf(gate, deps).execute(system, { customerAccountId: CUSTOMER });
    if (!result.ok) throw new Error(result.error.code);
    return result.value;
  };
  const sweep = () => new ExpireWalletCredit(gate, deps).execute(system, {});
  const lotsOf = () => [...wallet.lots.values()].map((l) => [l.source, l.remaining] as const);
  const snapshot = () =>
    JSON.stringify(
      {
        balances: [...wallet.balances.values()],
        lots: [...wallet.lots.values()],
        journals: wallet.journals.length,
      },
      (_key, value: unknown) => (typeof value === 'bigint' ? value.toString() : value),
    );

  // ---- the switch -------------------------------------------------------------------------

  describe('the Market switch', () => {
    it('is off by default: every write answers wallet.disabled and the customer sees nothing', async () => {
      expect(await new ViewWalletSettings(gate, deps).execute(adminCtx(), {})).toEqual(
        ok({ status: 'off', reason: null, updatedAt: null, version: 0 }),
      );
      expect(await grant(100n)).toEqual(err({ code: 'wallet.disabled' }));
      expect(await hold(100n)).toEqual(err({ code: 'wallet.disabled' }));
      expect(await settle('capture')).toEqual(err({ code: 'wallet.disabled' }));
      expect(await settle('release')).toEqual(err({ code: 'wallet.disabled' }));
      expect(await new ViewMyWallet(gate, deps).execute(customerCtx(), {})).toEqual(
        err({ code: 'wallet.disabled' }),
      );
      expect(await new ViewMyHistory(gate, deps).execute(customerCtx(), {})).toEqual(
        err({ code: 'wallet.disabled' }),
      );
      expect(wallet.journals).toHaveLength(0);
    });

    it('a balance can still be read by a system caller when the wallet is off', async () => {
      const read = await balance();
      expect(read.available).toEqual(amount(0n));
      expect(read.marketStatus).toBe('off');
    });

    it('round trip: active, paused, frozen, active; each change is audited with before and after', async () => {
      await open('active');
      await turn('paused', 'wind-down');
      await turn('frozen', 'security-incident');
      await turn('active');
      const proof = { stepUpSessionId: ADMIN_SESSION, stepUpVerifiedAt: T0 };
      expect(audit.entries.map((e) => [e.before, e.after])).toEqual([
        [
          { status: 'off', reason: null },
          { status: 'active', reason: null, ...proof },
        ],
        [
          { status: 'active', reason: null },
          { status: 'paused', reason: 'wind-down', ...proof },
        ],
        [
          { status: 'paused', reason: 'wind-down' },
          { status: 'frozen', reason: 'security-incident', ...proof },
        ],
        [
          { status: 'frozen', reason: 'security-incident' },
          { status: 'active', reason: null, ...proof },
        ],
      ]);
      expect(audit.entries.every((e) => e.targetId === 'wallet-settings')).toBe(true);
      expect(await new ViewWalletSettings(gate, deps).execute(adminCtx(), {})).toMatchObject({
        ok: true,
        value: { status: 'active', reason: null },
      });
    });

    it('is idempotent: the same state twice writes nothing and records one audit row', async () => {
      await open('active');
      const saves = setting.saves;
      const again = await turn('active');
      expect(again).toMatchObject({ ok: true, value: { status: 'active' } });
      expect(setting.saves).toBe(saves);
      expect(audit.entries).toHaveLength(1);
      // off to off with no row is also a no-op.
      setting.record = null;
      audit.entries.length = 0;
      await turn('off');
      expect(audit.entries).toHaveLength(0);
    });

    it('needs the manage key: without it the gate refuses and nothing changes', async () => {
      denyKeys = true;
      expect(await turn('active')).toEqual(err({ code: 'access.denied' }));
      expect(await new ViewWalletSettings(gate, deps).execute(adminCtx(), {})).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(setting.record).toBeNull();
      expect(audit.entries).toHaveLength(0);
    });

    it('is refused for a customer, and in an acting-as session', async () => {
      expect(await turn('active', undefined, customerCtx())).toEqual(
        err({ code: 'access.denied' }),
      );
      const context = adminCtx();
      const actingAs = {
        ...context,
        actor: { ...context.actor, actingAs: { adminAccountId: ADMIN } },
      } as unknown as CallContext;
      // The gate refuses a context that is not minted, so the flow itself is called here: it must
      // refuse the reserved acting-as marker on its own, before any write.
      expect(await setStatus(deps, actingAs, { status: 'active' })).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(setting.record).toBeNull();
      expect(audit.entries).toHaveLength(0);
    });

    it('spends the admin step-up of wallet.settings.change in the unit of the change, fail closed', async () => {
      await open('active');
      expect(stepUpAsked).toEqual(['wallet.settings.change']);
      audit.entries.length = 0;
      const saves = setting.saves;
      for (const refusal of [
        { code: 'second-factor.required', actionKey: 'wallet.settings.change' },
        { code: 'second-factor.enrolment-required', actionKey: 'wallet.settings.change' },
      ] as const) {
        stepUpAnswer = err(refusal);
        expect(await turn('paused', 'maintenance')).toEqual(err(refusal));
      }
      stepUpAnswer = err({ code: 'access.unavailable' });
      expect(await turn('paused', 'maintenance')).toEqual(err({ code: 'access.unavailable' }));
      stepUpAnswer = err({ code: 'access.denied' });
      expect(await turn('paused', 'maintenance')).toEqual(err({ code: 'access.denied' }));
      expect(setting.saves).toBe(saves);
      expect(setting.record?.status).toBe('active');
      expect(audit.entries).toHaveLength(0);
    });

    it('spends no proof for an invalid body, a refused caller, a no-op or a refused change', async () => {
      expect((await turn('on')).ok).toBe(false);
      expect((await turn('active', undefined, customerCtx())).ok).toBe(false);
      await open('active');
      stepUpAsked = [];
      expect((await turn('active')).ok).toBe(true);
      expect(stepUpAsked).toEqual([]);
    });

    it('versions the switch: 0 before any change, +1 per real change, none for a no-op', async () => {
      const view = async () => {
        const result = await new ViewWalletSettings(gate, deps).execute(adminCtx(), {});
        if (!result.ok) throw new Error(result.error.code);
        return result.value.version;
      };
      expect(await view()).toBe(0);
      await open('active');
      expect(await view()).toBe(1);
      await turn('active'); // no-op
      expect(await view()).toBe(1);
      await turn('paused', 'maintenance');
      expect(await view()).toBe(2);
    });

    it('a stale expectedVersion answers wallet.settings-conflict and spends no proof (step-up ordering)', async () => {
      await open('active'); // version 1
      await turn('paused', 'maintenance'); // another admin: version 2
      stepUpAsked = [];
      audit.entries.length = 0;
      const saves = setting.saves;
      expect(await turn('frozen', 'security-incident', adminCtx(), 1)).toEqual(
        err({ code: 'wallet.settings-conflict' }),
      );
      // The stale save is refused before the unit reaches the step-up consumer.
      expect(stepUpAsked).toEqual([]);
      expect(setting.saves).toBe(saves);
      expect(setting.record).toMatchObject({ status: 'paused', version: 2 });
      expect(audit.entries).toHaveLength(0);
      // The same request with the current version goes through and then spends the proof once.
      expect((await turn('frozen', 'security-incident', adminCtx(), 2)).ok).toBe(true);
      expect(stepUpAsked).toEqual(['wallet.settings.change']);
    });

    it('a stale version is a conflict even for the state already set, and a first save needs 0', async () => {
      expect(await turn('active', undefined, adminCtx(), 3)).toEqual(
        err({ code: 'wallet.settings-conflict' }),
      );
      expect((await turn('active', undefined, adminCtx(), 0)).ok).toBe(true);
      expect(await turn('active', undefined, adminCtx(), 0)).toEqual(
        err({ code: 'wallet.settings-conflict' }),
      );
      expect(stepUpAsked).toEqual(['wallet.settings.change']);
    });

    it('keeps the conflict and the history refusal distinct, and checks the version first', async () => {
      await open('active');
      expect((await grant(100n)).ok).toBe(true);
      expect(await turn('off')).toEqual(err({ code: 'wallet.cannot-turn-off-with-history' }));
      expect(await turn('off', undefined, adminCtx(), 0)).toEqual(
        err({ code: 'wallet.settings-conflict' }),
      );
    });

    it('requires expectedVersion: a missing, negative or fractional value is a field error', async () => {
      await open('active');
      stepUpAsked = [];
      for (const [value, code] of [
        [-1, 'value'],
        [1.5, 'value'],
        ['1', 'value'],
      ] as const) {
        expect(await turn('paused', 'maintenance', adminCtx(), value)).toEqual(
          err({ code: 'validation.failed', fields: [{ path: 'expectedVersion', code }] }),
        );
      }
      // Left out entirely (a default parameter would fill in `undefined`, so call the use case).
      expect(
        await new SetWalletStatus(gate, deps).execute(adminCtx(), {
          status: 'paused',
          reasonCode: 'maintenance',
        }),
      ).toEqual(
        err({
          code: 'validation.failed',
          fields: [{ path: 'expectedVersion', code: 'required' }],
        }),
      );
      expect(stepUpAsked).toEqual([]);
      expect(setting.record?.status).toBe('active');
    });

    it('validates the body: a reason is required for paused and frozen and not allowed otherwise', async () => {
      await open('active');
      expect(await turn('paused')).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'required' }] }),
      );
      expect(await turn('frozen', 'because')).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'value' }] }),
      );
      expect(await turn('active', 'maintenance')).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'not-allowed' }] }),
      );
      expect(await turn('on')).toEqual(
        err({ code: 'validation.failed', fields: [{ path: 'status', code: 'value' }] }),
      );
    });

    it('refuses going back to off once the Market has a journal (use paused)', async () => {
      await open('active');
      expect((await turn('off')).ok).toBe(true);
      await open('active');
      expect((await grant(100n)).ok).toBe(true);
      expect(await turn('off')).toEqual(err({ code: 'wallet.cannot-turn-off-with-history' }));
      expect((await turn('paused', 'wind-down')).ok).toBe(true);
      stepUpAsked = [];
      expect(await turn('off')).toEqual(err({ code: 'wallet.cannot-turn-off-with-history' }));
      // A refused change keeps the admin's proof for the next try.
      expect(stepUpAsked).toEqual([]);
    });
  });

  // ---- grants -----------------------------------------------------------------------------

  describe('grants', () => {
    beforeEach(open);

    it('creates a lot and raises the balance; promo expires after the Market months, refund never', async () => {
      const promo = await grant(1000n, 'promo');
      expect(promo).toMatchObject({ ok: true, value: { balance: { available: amount(1000n) } } });
      await grant(500n, 'refund');
      const lots = [...wallet.lots.values()];
      expect(lots.find((l) => l.source === 'refund')!.expiresAt).toBeNull();
      expect(lots.find((l) => l.source === 'promo')!.expiresAt!.toString()).toBe(
        T0.toZonedDateTimeISO(config.timezone).add({ months: promoMonths }).toInstant().toString(),
      );
      expect((await balance()).available).toEqual(amount(1500n));
    });

    it('books balanced journals against the platform accounts', async () => {
      await grant(1000n, 'promo');
      await grant(500n, 'refund');
      for (const journal of wallet.journals) {
        expect(journal.postings.reduce((sum, p) => sum + p.amountMinor, 0n)).toBe(0n);
        expect(journal.postings.length).toBeGreaterThanOrEqual(2);
      }
      const kinds = [...wallet.accounts.values()].map((a) => a.kind).sort();
      expect(kinds).toEqual(['credit_liability', 'promo_expense', 'refund_clearing']);
    });

    it('same key and same request returns the first result and writes nothing again', async () => {
      const first = await grant(1000n, 'promo', 'grant-key-1');
      const journals = wallet.journals.length;
      const second = await grant(1000n, 'promo', 'grant-key-1');
      expect(second).toEqual(first);
      expect(wallet.journals).toHaveLength(journals);
      expect((await balance()).available).toEqual(amount(1000n));
    });

    it('same key with another request is refused as idempotency.key-reused', async () => {
      await grant(1000n, 'promo', 'grant-key-1');
      expect(await grant(999n, 'promo', 'grant-key-1')).toEqual(
        err({ code: 'idempotency.key-reused' }),
      );
      expect(await grant(1000n, 'refund', 'grant-key-1')).toEqual(
        err({ code: 'idempotency.key-reused' }),
      );
      expect(await grant(1000n, 'promo', 'grant-key-1', OTHER_CUSTOMER)).toEqual(
        err({ code: 'idempotency.key-reused' }),
      );
    });

    it('is refused over the Market cap, counting what is held, and allowed up to the cap', async () => {
      expect((await grant(cap - 100n)).ok).toBe(true);
      expect(await grant(101n)).toEqual(err({ code: 'wallet.cap-exceeded' }));
      expect((await hold(50n)).ok).toBe(true);
      expect(await grant(101n)).toEqual(err({ code: 'wallet.cap-exceeded' }));
      expect((await grant(100n)).ok).toBe(true);
      expect((await balance()).available.amount + (await balance()).held.amount).toBe(cap);
    });

    it('is refused on a frozen or closed customer wallet', async () => {
      await grant(100n);
      const account = [...wallet.accounts.values()].find((a) => a.kind === 'credit_liability')!;
      wallet.accounts.set(account.id, { ...account, status: 'frozen' });
      expect(await grant(100n)).toEqual(err({ code: 'wallet.account-not-active' }));
      wallet.accounts.set(account.id, { ...account, status: 'closed' });
      expect(await grant(100n)).toEqual(err({ code: 'wallet.account-not-active' }));
      expect((await hold(10n)).ok).toBe(false);
    });

    it('validates the request', async () => {
      const bad = await new GrantCredit(gate, deps).execute(system, {
        customerAccountId: 'nope' as Id<'Account'>,
        source: 'gift' as 'promo',
        amount: money(0n, currency),
        reasonCode: 'Bad Reason',
        idempotencyKey: 'x',
      });
      expect(bad).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      const wrongCurrency = await new GrantCredit(gate, deps).execute(system, {
        customerAccountId: CUSTOMER,
        source: 'promo',
        amount: money(100n, currency === 'AUD' ? 'JPY' : 'AUD'),
        reasonCode: 'welcome',
        idempotencyKey: key('grant'),
      });
      expect(wallet.journals).toHaveLength(0);
      expect(wrongCurrency).toMatchObject({ ok: false, error: { fields: [{ path: 'amount' }] } });
    });

    it('is for the system only: a customer cannot grant themselves credit', async () => {
      const result = await new GrantCredit(gate, deps).execute(customerCtx(), {
        customerAccountId: CUSTOMER,
        source: 'promo',
        amount: amount(100n),
        reasonCode: 'welcome',
        idempotencyKey: key('grant'),
      });
      expect(result).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    });
  });

  // ---- holds ------------------------------------------------------------------------------

  describe('holds', () => {
    beforeEach(open);

    it('spends the soonest-expiring lot first, promo before refund, and never an expired lot', async () => {
      await grant(300n, 'refund');
      await grant(300n, 'promo');
      clock.advance(Temporal.Duration.from({ hours: 24 }));
      await grant(300n, 'promo');
      expect((await hold(400n)).ok).toBe(true);
      // The first promo lot expires first, then the second, then refund credit.
      expect(lotsOf()).toEqual([
        ['refund', 300n],
        ['promo', 0n],
        ['promo', 200n],
      ]);
      expect(await hold(1000n, ORDER_2)).toEqual(err({ code: 'wallet.insufficient-funds' }));
    });

    it('does not spend promo credit past its expiry', async () => {
      await grant(300n, 'promo');
      clock.advance(Temporal.Duration.from({ hours: 24 * 31 * promoMonths + 24 }));
      expect(await hold(100n)).toEqual(err({ code: 'wallet.insufficient-funds' }));
    });

    it('needs the amount to be available, one hold per order, and moves available to held', async () => {
      await grant(1000n);
      expect(await hold(1001n)).toEqual(err({ code: 'wallet.insufficient-funds' }));
      const placed = await hold(400n);
      expect(placed).toMatchObject({ ok: true, value: { status: 'held', amount: amount(400n) } });
      expect(await balance()).toMatchObject({ available: amount(600n), held: amount(400n) });
      expect(await hold(100n, ORDER_1)).toEqual(err({ code: 'wallet.hold-exists' }));
    });

    it('is idempotent by key and refuses a reused key for another request', async () => {
      await grant(1000n);
      const first = await hold(400n, ORDER_1, 'hold-key-1');
      expect(await hold(400n, ORDER_1, 'hold-key-1')).toEqual(first);
      expect(await balance()).toMatchObject({ available: amount(600n), held: amount(400n) });
      expect(await hold(300n, ORDER_1, 'hold-key-1')).toEqual(
        err({ code: 'idempotency.key-reused' }),
      );
    });

    it('a wallet that was never granted credit has nothing to hold', async () => {
      expect(await hold(1n)).toEqual(err({ code: 'wallet.insufficient-funds' }));
    });

    it('capture spends the held credit once; a second capture or a release afterwards is refused', async () => {
      await grant(1000n);
      await hold(400n);
      const captured = await settle('capture');
      expect(captured).toMatchObject({ ok: true, value: { status: 'captured' } });
      expect(await balance()).toMatchObject({ available: amount(600n), held: amount(0n) });
      expect(await settle('capture')).toEqual(err({ code: 'wallet.hold-not-held' }));
      expect(await settle('release')).toEqual(err({ code: 'wallet.hold-not-held' }));
      const kinds = wallet.journals.map((j) => j.kind);
      expect(kinds).toEqual(['grant-promo', 'hold', 'capture']);
    });

    it('capture and release are idempotent by key', async () => {
      await grant(1000n);
      await hold(400n);
      const first = await settle('capture', ORDER_1, 'capture-key-1');
      expect(await settle('capture', ORDER_1, 'capture-key-1')).toEqual(first);
      expect(wallet.journals.filter((j) => j.kind === 'capture')).toHaveLength(1);
      expect(await settle('capture', ORDER_2, 'capture-key-1')).toEqual(
        err({ code: 'idempotency.key-reused' }),
      );
    });

    it('release restores the exact lots and the available balance', async () => {
      await grant(300n, 'refund');
      await grant(300n, 'promo');
      const before = lotsOf();
      await hold(450n);
      expect(lotsOf()).not.toEqual(before);
      const released = await settle('release');
      expect(released).toMatchObject({ ok: true, value: { status: 'released' } });
      expect(lotsOf()).toEqual(before);
      expect(await balance()).toMatchObject({ available: amount(600n), held: amount(0n) });
      // Released credit can be held again for the order.
      expect(await settle('release')).toEqual(err({ code: 'wallet.hold-not-held' }));
    });

    it('capture or release of an order without a hold is wallet.not-found', async () => {
      await grant(100n);
      expect(await settle('capture', ORDER_2)).toEqual(err({ code: 'wallet.not-found' }));
      expect(await settle('release', ORDER_2)).toEqual(err({ code: 'wallet.not-found' }));
    });

    it('every journal balances and the cached balance equals the sum of the lots', async () => {
      await grant(700n, 'promo');
      await grant(300n, 'refund');
      await hold(500n);
      await settle('capture');
      await hold(100n, ORDER_2);
      await settle('release', ORDER_2);
      for (const journal of wallet.journals) {
        expect(journal.postings.reduce((sum, p) => sum + p.amountMinor, 0n)).toBe(0n);
      }
      const inLots = [...wallet.lots.values()].reduce((sum, l) => sum + l.remaining, 0n);
      expect((await balance()).available.amount).toBe(inLots);
    });
  });

  // ---- the states in use ------------------------------------------------------------------

  describe('review hardening', () => {
    beforeEach(async () => {
      await open();
    });

    it('answers wallet.busy when the switch cannot be locked in time', async () => {
      deps = {
        ...deps,
        unitOfWork: {
          run: () => Promise.reject(new TransactionConflictError('55P03')),
        } as unknown as WalletDependencies['unitOfWork'],
      };
      expect(await turn('paused', 'maintenance')).toEqual(err({ code: 'wallet.busy' }));
    });

    it('keeps the sys: prefix for the keys the worker generates', async () => {
      const refused = err({
        code: 'validation.failed',
        fields: [{ path: 'idempotencyKey', code: 'format' }],
      });
      expect(await grant(10n, 'promo', 'sys:hold-expire:abcdef')).toEqual(refused);
      expect(await hold(10n, ORDER_1, 'sys:hold-expire:abcdef')).toEqual(refused);
      await grant(100n);
      await hold(50n, ORDER_1, 'caller-key-1');
      clock.advance(Temporal.Duration.from({ hours: 3 }));
      expect(await sweep()).toMatchObject({ ok: true, value: { expiredHolds: 1, failed: [] } });
      expect(
        wallet.journals.map((j) => j.idempotencyKey).filter((k) => k.startsWith('sys:')),
      ).toHaveLength(1);
    });

    it('refuses to capture a hold past its expiry, until the sweep releases it', async () => {
      await grant(500n);
      await hold(200n, ORDER_1, 'caller-key-1', 1);
      expect((await settle('capture', ORDER_1)).ok).toBe(true);
      await hold(100n, ORDER_2, 'caller-key-2', 1);
      clock.advance(Temporal.Duration.from({ hours: 2 }));
      expect(await settle('capture', ORDER_2)).toEqual(err({ code: 'wallet.hold-expired' }));
      expect((await settle('release', ORDER_2)).ok).toBe(true);
      expect(await settle('capture', ORDER_2)).toEqual(err({ code: 'wallet.hold-not-held' }));
    });

    it('answers a replayed placeHold with the hold as it is now', async () => {
      await grant(500n);
      const first = await hold(200n, ORDER_1, 'caller-key-1');
      expect(first).toMatchObject({ ok: true, value: { status: 'held' } });
      expect(await hold(200n, ORDER_1, 'caller-key-1')).toEqual(first);
      await settle('capture', ORDER_1);
      expect(await hold(200n, ORDER_1, 'caller-key-1')).toMatchObject({
        ok: true,
        value: { status: 'captured' },
      });
    });

    it('fails closed when the wallet is not in the Market currency', async () => {
      await grant(500n);
      for (const account of wallet.accounts.values()) {
        if (account.customer !== null)
          wallet.accounts.set(account.id, { ...account, currency: 'XXX' });
      }
      expect(await grant(10n)).toEqual(err({ code: 'wallet.unavailable' }));
      expect(await hold(10n, ORDER_1)).toEqual(err({ code: 'wallet.unavailable' }));
    });
  });

  describe('paused and frozen', () => {
    beforeEach(async () => {
      await open();
      await grant(1000n);
      await hold(300n, ORDER_1);
      await hold(200n, ORDER_2);
    });

    it('paused: no new grants or holds; existing holds still capture and release; reads work', async () => {
      await turn('paused', 'wind-down');
      expect(await grant(10n)).toEqual(err({ code: 'wallet.paused' }));
      expect(await hold(10n, id<'Order'>(0x103))).toEqual(err({ code: 'wallet.paused' }));
      expect((await settle('capture', ORDER_1)).ok).toBe(true);
      expect((await settle('release', ORDER_2)).ok).toBe(true);
      expect(await new ViewMyWallet(gate, deps).execute(customerCtx(), {})).toMatchObject({
        ok: true,
        value: { available: 700n, marketStatus: 'paused' },
      });
    });

    it('a retry with a known key gets its first answer after the switch changed; a new key meets the gate', async () => {
      const order3 = id<'Order'>(0x104);
      const first = {
        grant: await grant(50n, 'promo', 'replay-grant-1'),
        hold: await hold(40n, order3, 'replay-hold-1'),
        capture: await settle('capture', ORDER_1, 'replay-capture-1'),
        release: await settle('release', ORDER_2, 'replay-release-1'),
      };
      for (const result of Object.values(first)) expect(result.ok).toBe(true);
      const before = snapshot();
      await turn('paused', 'wind-down');
      expect(await grant(50n, 'promo', 'replay-grant-1')).toEqual(first.grant);
      expect(await hold(40n, order3, 'replay-hold-1')).toEqual(first.hold);
      expect(await settle('capture', ORDER_1, 'replay-capture-1')).toEqual(first.capture);
      expect(await settle('release', ORDER_2, 'replay-release-1')).toEqual(first.release);
      await turn('frozen', 'security-incident');
      expect(await grant(50n, 'promo', 'replay-grant-1')).toEqual(first.grant);
      expect(await hold(40n, order3, 'replay-hold-1')).toEqual(first.hold);
      expect(await settle('capture', ORDER_1, 'replay-capture-1')).toEqual(first.capture);
      expect(snapshot()).toBe(before);
      expect(await grant(50n, 'promo', 'replay-grant-2')).toEqual(err({ code: 'wallet.frozen' }));
      expect(await hold(40n, id<'Order'>(0x105), 'replay-hold-2')).toEqual(
        err({ code: 'wallet.frozen' }),
      );
      expect(await settle('capture', order3, 'replay-capture-2')).toEqual(
        err({ code: 'wallet.frozen' }),
      );
      expect(await wallet.reconcile()).toEqual([]);
    });

    it('frozen: no grants, holds or capture; release still works; reads work', async () => {
      await turn('frozen', 'security-incident');
      expect(await grant(10n)).toEqual(err({ code: 'wallet.frozen' }));
      expect(await hold(10n, id<'Order'>(0x103))).toEqual(err({ code: 'wallet.frozen' }));
      expect(await settle('capture', ORDER_1)).toEqual(err({ code: 'wallet.frozen' }));
      expect((await settle('release', ORDER_1)).ok).toBe(true);
      expect((await balance()).marketStatus).toBe('frozen');
      expect(await new ViewMyHistory(gate, deps).execute(customerCtx(), {})).toMatchObject({
        ok: true,
      });
    });

    it('hard rule 1: no switch change deletes or zeroes a balance or a lot', async () => {
      const before = snapshot();
      await turn('paused', 'wind-down');
      await turn('frozen', 'security-incident');
      await turn('active');
      await turn('paused', 'maintenance');
      expect(snapshot()).toBe(before);
    });
  });

  // ---- the worker sweeps ------------------------------------------------------------------

  describe('expiry sweeps', () => {
    it('release holds past their expiry, in active, paused and frozen alike (hard rules 2 and 3)', async () => {
      await open();
      await grant(1000n);
      await hold(300n, ORDER_1);
      await hold(200n, ORDER_2, key('hold'), 5);
      clock.advance(Temporal.Duration.from({ hours: 3 }));
      await turn('frozen', 'security-incident');
      expect(await sweep()).toMatchObject({
        ok: true,
        value: { expiredHolds: 1, expiredLots: 0, failed: [] },
      });
      expect(await balance()).toMatchObject({ available: amount(800n), held: amount(200n) });
      expect(wallet.holds.get([...wallet.holds.keys()][0]!)!.status).toBe('expired');
      await turn('paused', 'wind-down');
      clock.advance(Temporal.Duration.from({ hours: 3 }));
      expect(await sweep()).toMatchObject({ ok: true, value: { expiredHolds: 1 } });
      expect(await balance()).toMatchObject({ available: amount(1000n), held: amount(0n) });
      // Running again finds nothing, and the lots are back where they were.
      expect(await sweep()).toMatchObject({ ok: true, value: { expiredHolds: 0, expiredLots: 0 } });
      expect(lotsOf()).toEqual([['promo', 1000n]]);
    });

    it('does nothing while the wallet is off', async () => {
      await open();
      await grant(1000n);
      await hold(300n);
      await turn('paused', 'wind-down');
      setting.record = { ...setting.record!, status: 'off', reason: null };
      clock.advance(Temporal.Duration.from({ hours: 3 }));
      expect(await sweep()).toMatchObject({ ok: true, value: { expiredHolds: 0, expiredLots: 0 } });
      expect(wallet.holds.size).toBe(1);
      expect([...wallet.holds.values()][0]!.status).toBe('held');
    });

    it('expires promo lots past their expiry to breakage income, never refund credit', async () => {
      await open();
      await grant(600n, 'promo');
      await grant(400n, 'refund');
      clock.advance(Temporal.Duration.from({ hours: 24 * 31 * promoMonths + 24 }));
      expect(await sweep()).toMatchObject({ ok: true, value: { expiredLots: 1 } });
      expect(lotsOf()).toEqual([
        ['promo', 0n],
        ['refund', 400n],
      ]);
      expect((await balance()).available).toEqual(amount(400n));
      const expire = wallet.journals.find((j) => j.kind === 'expire')!;
      const breakage = [...wallet.accounts.values()].find((a) => a.kind === 'breakage_income')!;
      expect(expire.postings).toContainEqual({ accountId: breakage.id, amountMinor: 600n });
      expect(expire.postings.reduce((sum, p) => sum + p.amountMinor, 0n)).toBe(0n);
      // The lot and its history stay; a second run finds nothing.
      expect(wallet.lots.size).toBe(2);
      expect(await sweep()).toMatchObject({ ok: true, value: { expiredLots: 0 } });
    });

    it('credit held while its lot expires is expired once the hold is released', async () => {
      await open();
      await grant(600n, 'promo');
      await hold(250n);
      clock.advance(Temporal.Duration.from({ hours: 24 * 31 * promoMonths + 24 }));
      // The unheld 350 expires; the hold itself expired with the same clock jump.
      await sweep();
      expect((await balance()).available).toEqual(amount(0n));
      await sweep();
      expect(lotsOf()).toEqual([['promo', 0n]]);
      expect(await balance()).toMatchObject({ available: amount(0n), held: amount(0n) });
    });
  });

  // ---- customer reads ---------------------------------------------------------------------

  describe('customer reads', () => {
    beforeEach(open);

    it('shows the balance and promo credit expiring soon, in the Market currency', async () => {
      await grant(500n, 'refund');
      await grant(700n, 'promo');
      const soon = config.wallet!.expiringSoonDays;
      const expiresAt = [...wallet.lots.values()].find((l) => l.source === 'promo')!.expiresAt!;
      clock.set(expiresAt.subtract({ hours: 24 * (soon - 1) }));
      const view = await new ViewMyWallet(gate, deps).execute(customerCtx(), {});
      expect(view).toMatchObject({
        ok: true,
        value: { currency, available: 1200n, held: 0n, marketStatus: 'active' },
      });
      expect(view.ok && view.value.expiringSoon.map((l) => l.amount)).toEqual([700n]);
    });

    it('lists only the customer own history, newest first', async () => {
      await grant(500n);
      await grant(300n, 'promo', key('grant'), OTHER_CUSTOMER);
      await hold(200n);
      const mine = await new ViewMyHistory(gate, deps).execute(customerCtx(), {});
      expect(mine.ok && mine.value.entries.map((e) => [e.kind, e.amount])).toEqual([
        ['hold', -200n],
        ['grant-promo', 500n],
      ]);
      const theirs = await new ViewMyHistory(gate, deps).execute(customerCtx(OTHER_CUSTOMER), {});
      expect(theirs.ok && theirs.value.entries.map((e) => e.amount)).toEqual([300n]);
    });

    it('refuses a bad page and any actor that is not a customer', async () => {
      expect(
        await new ViewMyHistory(gate, deps).execute(customerCtx(), { limit: 0 }),
      ).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(
        await new ViewMyHistory(gate, deps).execute(customerCtx(), { cursor: 'x' }),
      ).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
      expect(await new ViewMyWallet(gate, deps).execute(adminCtx(), {})).toEqual(
        err({ code: 'access.denied' }),
      );
      expect(await new ViewMyWallet(gate, deps).execute(system, {})).toMatchObject({ ok: false });
    });

    it('works in an acting-as session (support may look)', async () => {
      const context = customerCtx();
      const actingAs = {
        ...context,
        actor: { ...context.actor, actingAs: { adminAccountId: ADMIN } },
      } as unknown as CallContext;
      expect(await viewMyWallet(deps, actingAs)).toMatchObject({ ok: true });
    });
  });

  it('the admin balance read answers a platform admin only, not an acting-as session', async () => {
    await open();
    const read = new AdminBalanceOf(gate, deps);
    expect(await read.execute(adminCtx(), { customerAccountId: CUSTOMER })).toMatchObject({
      ok: true,
    });
    const actingAs = {
      ...adminCtx(),
      actor: { ...adminCtx().actor, actingAs: { adminAccountId: CUSTOMER } },
    } as unknown as CallContext;
    for (const context of [actingAs, system]) {
      expect(await read.execute(context, { customerAccountId: CUSTOMER })).toMatchObject({
        ok: false,
      });
    }
  });

  it('the facade passes the caller context unchanged to the use cases', async () => {
    await open();
    const facade = new WalletFacadeImplementation(
      new GrantCredit(gate, deps),
      new PlaceHold(gate, deps),
      new CaptureHold(gate, deps),
      new ReleaseHold(gate, deps),
      new BalanceOf(gate, deps),
      new OwnBalanceOf(gate, deps),
      new AdminBalanceOf(gate, deps),
    );
    const granted = await facade.grantCredit(system, {
      customerAccountId: CUSTOMER,
      source: 'refund',
      amount: amount(100n),
      reasonCode: 'order-refund',
      idempotencyKey: 'facade-key-1',
    });
    expect(granted.ok).toBe(true);
    expect(await facade.balanceOf(system, CUSTOMER)).toMatchObject({
      ok: true,
      value: { available: amount(100n) },
    });
    expect(
      await facade.grantCredit(customerCtx(), {
        customerAccountId: CUSTOMER,
        source: 'refund',
        amount: amount(100n),
        reasonCode: 'order-refund',
        idempotencyKey: 'facade-key-2',
      }),
    ).toMatchObject({ ok: false, error: { code: 'access.denied' } });
    // The customer's own balance comes from the session, in any state; the system actor has none.
    expect(await facade.ownBalanceOf(customerCtx())).toMatchObject({
      ok: true,
      value: { available: amount(100n) },
    });
    expect(await facade.ownBalanceOf(system)).toMatchObject({
      ok: false,
      error: { code: 'access.denied' },
    });
  });
});
