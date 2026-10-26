import { err, money, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { AuditEntry, CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeCustomerDirectory,
  MemoryAdminCredits,
  MemoryMarketSetting,
  MemoryWallet,
} from '../../../../test/support/wallet-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import type { AuditWriter } from '../../../platform/audit/audit-writer';
import type { AccessDecision } from '../../../platform/authz';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { WALLET_AUDIT_ACTIONS } from '../domain/audit';
import { ConfigWalletPolicy } from '../infrastructure/config-wallet-policy';
import {
  approveAdminCredit,
  issueAdminCredit,
  journalKeyOf,
  listAdminCredits,
  viewCustomerWallet,
} from './admin-credit-flow';
import { ApproveAdminCredit } from './use-cases/approve-admin-credit.use-case';
import { ExpireAdminCreditRequests } from './use-cases/expire-admin-credit-requests.use-case';
import { GrantCredit } from './use-cases/grant-credit.use-case';
import { IssueAdminCredit } from './use-cases/issue-admin-credit.use-case';
import { ListAdminCreditRequests } from './use-cases/list-admin-credit-requests.use-case';
import { RejectAdminCredit } from './use-cases/reject-admin-credit.use-case';
import { ViewCustomerWallet } from './use-cases/view-customer-wallet.use-case';
import type { AdminCreditDependencies } from './wallet-dependencies';

// Admin credit issuance with maker-checker (customer wallet package 2a) in memory, on both Market
// fixtures (AU: AUD, 50.00 per issue, 500.00 per day, cap 500.00, Brisbane, 7 days; ZZ: JPY, 3000,
// 30000, cap 30000, Tokyo, 3 days). The tables' own guards, single use of the step-up proof and
// the daily cap under concurrency have their database spec (wallet-admin-credit.db-spec.ts).

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-25T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const CUSTOMER = id<'Account'>(0xc1);
const MAKER = id<'Account'>(0xa1);
const CHECKER = id<'Account'>(0xa2);
const SELLER_ACCOUNT = id<'Account'>(0xb1);
const FOREIGN_CUSTOMER = id<'Account'>(0xc2);
const CLOSED_CUSTOMER = id<'Account'>(0xc3);
const UNKNOWN_ACCOUNT = id<'Account'>(0xc4);
const ISSUE = 'wallet.credit.issue';
const APPROVE = 'wallet.credit.approve';

const ACTIONS = new Set<string>(WALLET_AUDIT_ACTIONS.map((a) => a.action));

class RecordingAudit implements AuditWriter {
  readonly entries: AuditEntry[] = [];
  record(_context: CallContext, entry: AuditEntry): Promise<void> {
    if (!ACTIONS.has(entry.action)) throw new Error(`audit: unknown action ${entry.action}`);
    this.entries.push(entry);
    return Promise.resolve();
  }
}

describe.each([['AU'], ['ZZ']] as const)('admin credit issuance in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const otherMarket = code === 'AU' ? 'ZZ' : 'AU';
  const config = markets.get(market.marketId);
  const currency = config.defaultCurrency;
  const wallet$ = config.wallet!;
  const issueCap = BigInt(wallet$.adminIssueCapMinor);
  const dailyCap = BigInt(wallet$.adminDailyCapMinor);
  const balanceCap = BigInt(wallet$.balanceCapMinor);
  const expiryDays = wallet$.adminRequestExpiryDays;
  const amount = (minor: bigint) => money(minor, currency);

  let clock: FixedClock;
  let denyKeys: boolean;
  let gate: ReturnType<typeof createUseCaseGate>;
  let wallet: MemoryWallet;
  let setting: MemoryMarketSetting;
  let credits: MemoryAdminCredits;
  let customers: FakeCustomerDirectory;
  let audit: RecordingAudit;
  let deps: AdminCreditDependencies;
  let seq = 0;
  let stepUpAnswer: Awaited<ReturnType<AdminCreditDependencies['stepUp']['consume']>> | null;
  let stepUpAsked: string[];

  const adminCtx = (accountId: Id<'Account'>) =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId,
        sessionId: id<'Session'>(accountId === MAKER ? 0x61 : 0x62),
        sellerId: null,
      }),
      'wallet-admin-credit-abcd',
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
    setting.record = { status: 'active', reason: null, updatedAt: T0, updatedBy: CHECKER };
    credits = new MemoryAdminCredits();
    customers = new FakeCustomerDirectory();
    customers.add(CUSTOMER, market.marketId);
    customers.add(SELLER_ACCOUNT, market.marketId, 'seller');
    customers.add(MAKER, market.marketId, 'admin');
    customers.add(FOREIGN_CUSTOMER, otherMarket);
    customers.add(CLOSED_CUSTOMER, market.marketId, 'customer', 'disabled');
    audit = new RecordingAudit();
    stepUpAnswer = null;
    stepUpAsked = [];
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      wallet,
      settings: setting,
      policy: new ConfigWalletPolicy(markets),
      audit,
      ids: new SequenceIdGenerator(clock),
      clock,
      credits,
      identity: customers,
      stepUp: {
        consume: (context, actionKey) => {
          stepUpAsked.push(actionKey);
          return Promise.resolve(
            stepUpAnswer ??
              ok({
                sessionId: (context.actor as { sessionId: Id<'Session'> }).sessionId,
                verifiedAt: clock.now(),
              }),
          );
        },
      },
    };
  });

  const key = () => `issue-key-${String((seq += 1)).padStart(4, '0')}`;
  const issue = (
    minor: bigint,
    options: { by?: Id<'Account'>; idempotencyKey?: string; note?: unknown; reason?: unknown } = {},
  ) =>
    new IssueAdminCredit(gate, deps).execute(adminCtx(options.by ?? MAKER), {
      customerAccountId: CUSTOMER,
      amount: amount(minor),
      reasonCode: options.reason ?? 'goodwill',
      note: options.note,
      idempotencyKey: options.idempotencyKey ?? key(),
    });
  const approve = (requestId: string, by = CHECKER) =>
    new ApproveAdminCredit(gate, deps).execute(adminCtx(by), { requestId });
  const reject = (requestId: string, by = CHECKER, reasonCode: unknown = 'duplicate') =>
    new RejectAdminCredit(gate, deps).execute(adminCtx(by), { requestId, reasonCode });
  const available = () =>
    [...wallet.balances.values()].reduce((sum, b) => sum + b.availableMinor, 0n);
  const pendingOf = async (minor: bigint) => {
    const result = await issue(minor);
    if (!result.ok || result.value.status !== 'pending') throw new Error('expected pending');
    return result.value;
  };
  const actions = () => audit.entries.map((e) => e.action);

  describe('issue within the caps', () => {
    it('grants promo credit at once, up to the per-issue cap, with a journal, a lot and an audit row', async () => {
      const result = await issue(issueCap, { note: '  parcel lost  ' });
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: 'granted',
          amount: issueCap,
          currency,
          approvalReason: null,
          note: 'parcel lost',
        },
      });
      if (!result.ok) return;
      expect(available()).toBe(issueCap);
      expect(wallet.journals).toHaveLength(1);
      const journal = wallet.journals[0]!;
      expect(journal).toMatchObject({
        kind: 'grant-promo',
        reasonCode: 'goodwill',
        idempotencyKey: journalKeyOf(result.value.id),
        actor: { kind: 'admin', id: MAKER },
      });
      expect(result.value.journalId).toBe(journal.id);
      // Promo cost is the platform's; the lot expires as any promo credit.
      const lot = [...wallet.lots.values()][0]!;
      expect(lot.source).toBe('promo');
      expect(lot.expiresAt).not.toBeNull();
      expect(stepUpAsked).toEqual([ISSUE]);
      expect(audit.entries).toHaveLength(1);
      expect(audit.entries[0]).toMatchObject({
        action: 'wallet.admin-credit.issued',
        targetId: result.value.id,
        after: { status: 'granted', amount: amount(issueCap), reasonCode: 'goodwill' },
      });
      // The note is stored for the admins and is never put in the journal or the audit row.
      const text = (value: unknown) =>
        JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v));
      expect(text(audit.entries)).not.toContain('parcel');
      expect(JSON.stringify(journal.result)).not.toContain('parcel');
      // The stored fingerprint is a SHA-256 of the fields, never the note (review S2).
      const stored = credits.rows.get(result.value.id)!;
      expect(stored.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.fingerprint).not.toContain('parcel');
    });

    it('sends one minor unit above the per-issue cap to a second admin, with no ledger effect', async () => {
      const result = await issue(issueCap + 1n);
      expect(result).toMatchObject({
        ok: true,
        value: {
          status: 'pending',
          approvalReason: 'issue-cap',
          journalId: null,
          expiresAt: T0.toZonedDateTimeISO(config.timezone).add({ days: expiryDays }).toInstant(),
        },
      });
      expect(wallet.journals).toHaveLength(0);
      expect(available()).toBe(0n);
      expect(stepUpAsked).toEqual([ISSUE]);
      expect(actions()).toEqual(['wallet.admin-credit.requested']);
    });

    it("counts the admin's day: exactly the daily cap is granted, one more unit waits", async () => {
      const chunks = dailyCap / issueCap;
      for (let n = 0n; n < chunks; n += 1n) {
        expect((await issue(issueCap)).ok).toBe(true);
      }
      expect([...credits.rows.values()].every((r) => r.status === 'granted')).toBe(true);
      // The balance cap is a separate rule: on both fixtures it equals the daily cap.
      expect(balanceCap).toBeGreaterThanOrEqual(dailyCap);
      expect(credits.rows.size).toBe(Number(chunks));
      expect(available()).toBe(dailyCap);
      const next = await issue(1n);
      expect(next).toMatchObject({
        ok: true,
        value: { status: 'pending', approvalReason: 'daily-cap' },
      });
      // Another admin's day is their own: not sent for approval, only held by the customer's
      // balance cap, which these grants filled.
      expect(await issue(1n, { by: CHECKER })).toEqual({
        ok: false,
        error: { code: 'wallet.cap-exceeded' },
      });
    });

    it('counts pending requests toward the day, and frees what is rejected', async () => {
      const big = await pendingOf(dailyCap);
      expect(await issue(1n)).toMatchObject({
        ok: true,
        value: { status: 'pending', approvalReason: 'daily-cap' },
      });
      expect((await reject(big.id)).ok).toBe(true);
      expect(await issue(1n)).toMatchObject({ ok: true, value: { status: 'granted' } });
    });

    it("starts a new day at midnight in the Market's time zone", async () => {
      await pendingOf(dailyCap);
      expect((await issue(1n)).ok && credits.rows.size).toBe(2);
      // 10:00 UTC + 5 h is past midnight in Brisbane (+10) and Tokyo (+9).
      clock.set(T0.add({ hours: 5 }));
      expect(await issue(1n)).toMatchObject({ ok: true, value: { status: 'granted' } });
      expect(new Set(credits.dayLocks.map((l) => l.split('|')[1]))).toEqual(
        new Set(['2026-10-25', '2026-10-26']),
      );
    });

    it('refuses an amount in another currency, zero, a reason outside the list and a bad note', async () => {
      const other = currency === 'AUD' ? 'JPY' : 'AUD';
      const wrong = await new IssueAdminCredit(gate, deps).execute(adminCtx(MAKER), {
        customerAccountId: CUSTOMER,
        amount: money(100n, other),
        reasonCode: 'welcome',
        note: 'x'.repeat(501),
        idempotencyKey: 'short',
      });
      expect(wrong).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'amount', code: 'range' },
            { path: 'reasonCode', code: 'value' },
            { path: 'note', code: 'length' },
            { path: 'idempotencyKey', code: 'format' },
          ],
        },
      });
      expect(await issue(0n)).toMatchObject({ ok: false, error: { code: 'validation.failed' } });
      expect(stepUpAsked).toEqual([]);
      expect(credits.rows.size).toBe(0);
    });

    it('refuses a grant over the customer balance cap and spends no proof', async () => {
      await new GrantCredit(gate, deps).execute(system, {
        customerAccountId: CUSTOMER,
        source: 'refund',
        amount: amount(balanceCap),
        reasonCode: 'order-refund',
        idempotencyKey: 'refund-for-cap',
      });
      expect(await issue(1n)).toEqual({ ok: false, error: { code: 'wallet.cap-exceeded' } });
      expect(stepUpAsked).toEqual([]);
      expect(credits.rows.size).toBe(0);
    });
  });

  describe('idempotency', () => {
    it('answers the same key and request with the first result, once', async () => {
      const first = await issue(10n, { idempotencyKey: 'same-key-001' });
      const again = await issue(10n, { idempotencyKey: 'same-key-001' });
      expect(again).toEqual(first);
      expect(credits.rows.size).toBe(1);
      expect(wallet.journals).toHaveLength(1);
      expect(stepUpAsked).toEqual([ISSUE]);
    });

    it('refuses the same key with another request: amount, note or admin', async () => {
      await issue(10n, { idempotencyKey: 'same-key-002' });
      for (const changed of [
        issue(11n, { idempotencyKey: 'same-key-002' }),
        issue(10n, { idempotencyKey: 'same-key-002', note: 'other' }),
        issue(10n, { idempotencyKey: 'same-key-002', by: CHECKER }),
      ]) {
        expect(await changed).toEqual({ ok: false, error: { code: 'idempotency.key-reused' } });
      }
      expect(credits.rows.size).toBe(1);
    });
  });

  describe('who may issue and decide', () => {
    it('refuses an acting-as session, a customer and an admin without the key', async () => {
      // The acting-as marker on the actor (Login as Seller), as identity mints it.
      const context = adminCtx(MAKER);
      const actingAsCtx = {
        ...context,
        actor: { ...context.actor, actingAs: { adminAccountId: MAKER } },
      } as unknown as CallContext;
      const input = {
        customerAccountId: CUSTOMER,
        amount: amount(1n),
        reasonCode: 'goodwill',
        idempotencyKey: key(),
      };
      expect(await issueAdminCredit(deps, actingAsCtx, input)).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await approveAdminCredit(deps, actingAsCtx, { requestId: id(0x999) })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      const customer = testCallContext(
        market,
        testAuthenticatedActor(market, {
          population: 'customer',
          accountId: CUSTOMER,
          sessionId: id<'Session'>(0x63),
          sellerId: null,
        }),
        'wallet-customer-abcd',
      );
      expect(
        await new IssueAdminCredit(gate, deps).execute(customer, {
          customerAccountId: CUSTOMER,
          amount: amount(1n),
          reasonCode: 'goodwill',
          idempotencyKey: key(),
        }),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
      denyKeys = true;
      expect(await issue(1n)).toEqual({ ok: false, error: { code: 'access.denied' } });
      expect(stepUpAsked).toEqual([]);
      expect(credits.rows.size).toBe(0);
    });

    it('needs a fresh step-up proof to issue: without one nothing is written', async () => {
      stepUpAnswer = err({ code: 'second-factor.required', actionKey: ISSUE });
      expect(await issue(1n)).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: ISSUE },
      });
      expect(await issue(issueCap + 1n)).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: ISSUE },
      });
      stepUpAnswer = err({ code: 'second-factor.enrolment-required', actionKey: ISSUE });
      expect(await issue(1n)).toMatchObject({
        ok: false,
        error: { code: 'second-factor.enrolment-required' },
      });
      expect(credits.rows.size).toBe(0);
      expect(wallet.journals).toHaveLength(0);
      expect(audit.entries).toHaveLength(0);
    });

    it('lets a second, different admin approve: the credit is granted then, audited', async () => {
      const request = await pendingOf(issueCap + 1n);
      stepUpAsked = [];
      expect(await approve(request.id, MAKER)).toEqual({
        ok: false,
        error: { code: 'wallet.approver-is-requester' },
      });
      expect(await reject(request.id, MAKER)).toEqual({
        ok: false,
        error: { code: 'wallet.approver-is-requester' },
      });
      expect(stepUpAsked).toEqual([]);

      const approved = await approve(request.id);
      expect(approved).toMatchObject({
        ok: true,
        value: { status: 'approved', decidedBy: CHECKER, requestedBy: MAKER },
      });
      expect(stepUpAsked).toEqual([APPROVE]);
      expect(available()).toBe(issueCap + 1n);
      expect(wallet.journals[0]).toMatchObject({
        kind: 'grant-promo',
        idempotencyKey: journalKeyOf(request.id),
        actor: { kind: 'admin', id: CHECKER },
      });
      expect(actions()).toEqual(['wallet.admin-credit.requested', 'wallet.admin-credit.approved']);
      expect(audit.entries[1]).toMatchObject({
        before: { status: 'pending' },
        after: { status: 'approved', requestedBy: MAKER, amount: amount(issueCap + 1n) },
      });
      // Decided once.
      expect(await approve(request.id)).toEqual({
        ok: false,
        error: { code: 'wallet.credit-request-decided' },
      });
      expect(await reject(request.id)).toEqual({
        ok: false,
        error: { code: 'wallet.credit-request-decided' },
      });
    });

    it('needs the approver’s own proof; without it the request stays pending', async () => {
      const request = await pendingOf(issueCap + 1n);
      stepUpAnswer = err({ code: 'second-factor.required', actionKey: APPROVE });
      expect(await approve(request.id)).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: APPROVE },
      });
      expect(await reject(request.id)).toEqual({
        ok: false,
        error: { code: 'second-factor.required', actionKey: APPROVE },
      });
      expect(credits.rows.get(request.id)!.status).toBe('pending');
      expect(wallet.journals).toHaveLength(0);
    });

    it('rejects with a closed reason and moves no money', async () => {
      const request = await pendingOf(issueCap + 1n);
      expect(await reject(request.id, CHECKER, 'because')).toMatchObject({
        ok: false,
        error: { code: 'validation.failed', fields: [{ path: 'reasonCode', code: 'value' }] },
      });
      expect(await reject(request.id)).toMatchObject({
        ok: true,
        value: { status: 'rejected', decisionReason: 'duplicate', decidedBy: CHECKER },
      });
      expect(wallet.journals).toHaveLength(0);
      expect(actions()).toEqual(['wallet.admin-credit.requested', 'wallet.admin-credit.rejected']);
    });

    it('answers an unknown or malformed request id', async () => {
      expect(await approve(id(0x999))).toEqual({
        ok: false,
        error: { code: 'wallet.credit-request-not-found' },
      });
      expect(await approve('nope')).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });
  });

  describe('the wallet switch and the customer wallet', () => {
    it.each([
      ['paused', 'wallet.paused'],
      ['frozen', 'wallet.frozen'],
      ['off', 'wallet.disabled'],
    ] as const)('refuses new issues while the wallet is %s', async (status, refusal) => {
      setting.record = {
        status,
        reason: status === 'off' ? null : 'maintenance',
        updatedAt: T0,
        updatedBy: CHECKER,
      };
      expect(await issue(1n)).toEqual({ ok: false, error: { code: refusal } });
      expect(await issue(issueCap + 1n)).toEqual({ ok: false, error: { code: refusal } });
      expect(stepUpAsked).toEqual([]);
      expect(credits.rows.size).toBe(0);
    });

    it('checks the switch again at approval; the request stays pending', async () => {
      const request = await pendingOf(issueCap + 1n);
      setting.record = {
        status: 'paused',
        reason: 'maintenance',
        updatedAt: T0,
        updatedBy: CHECKER,
      };
      expect(await approve(request.id)).toEqual({ ok: false, error: { code: 'wallet.paused' } });
      expect(credits.rows.get(request.id)!.status).toBe('pending');
      // Rejecting needs no active wallet: it moves no money.
      expect((await reject(request.id)).ok).toBe(true);
    });

    it('checks the customer balance cap at the moment of approval', async () => {
      const request = await pendingOf(issueCap + 1n);
      await new GrantCredit(gate, deps).execute(system, {
        customerAccountId: CUSTOMER,
        source: 'refund',
        amount: amount(balanceCap - issueCap),
        reasonCode: 'order-refund',
        idempotencyKey: 'refund-near-cap',
      });
      stepUpAsked = [];
      expect(await approve(request.id)).toEqual({
        ok: false,
        error: { code: 'wallet.cap-exceeded' },
      });
      expect(stepUpAsked).toEqual([]);
      expect(credits.rows.get(request.id)!.status).toBe('pending');
    });

    it("checks the customer's wallet state at approval", async () => {
      const request = await pendingOf(issueCap + 1n);
      await issue(1n, { by: CHECKER });
      for (const [accountId, account] of wallet.accounts) {
        if (account.kind === 'credit_liability')
          wallet.accounts.set(accountId, { ...account, status: 'frozen' });
      }
      expect(await approve(request.id)).toEqual({
        ok: false,
        error: { code: 'wallet.account-not-active' },
      });
    });
  });

  describe('expiry of pending requests', () => {
    it('refuses a decision past the expiry, and the sweep marks the request expired', async () => {
      const request = await pendingOf(issueCap + 1n);
      clock.set(request.expiresAt!.subtract({ seconds: 1 }));
      expect(await new ExpireAdminCreditRequests(gate, deps).execute(system, {})).toEqual({
        ok: true,
        value: { expired: 0, failed: [] },
      });
      clock.set(request.expiresAt!);
      expect(await approve(request.id)).toEqual({
        ok: false,
        error: { code: 'wallet.credit-request-expired' },
      });
      expect(await new ExpireAdminCreditRequests(gate, deps).execute(system, {})).toEqual({
        ok: true,
        value: { expired: 1, failed: [] },
      });
      expect(credits.rows.get(request.id)).toMatchObject({ status: 'expired', decidedBy: null });
      expect(actions()).toEqual(['wallet.admin-credit.requested', 'wallet.admin-credit.expired']);
      expect(await approve(request.id)).toEqual({
        ok: false,
        error: { code: 'wallet.credit-request-decided' },
      });
      // Expired frees the day again.
      expect(await issue(1n)).toMatchObject({ ok: true });
      expect(await new ExpireAdminCreditRequests(gate, deps).execute(system, {})).toMatchObject({
        ok: true,
        value: { expired: 0 },
      });
    });

    it('is a system job only', async () => {
      expect(
        await new ExpireAdminCreditRequests(gate, deps).execute(adminCtx(CHECKER), {}),
      ).toEqual({ ok: false, error: { code: 'access.denied' } });
    });
  });

  describe('the customer id (review S1)', () => {
    const misses: readonly [string, Id<'Account'>][] = [
      ['an unknown id', UNKNOWN_ACCOUNT],
      ["a seller's account", SELLER_ACCOUNT],
      ["an admin's account", MAKER],
      ["another Market's customer", FOREIGN_CUSTOMER],
      ['a closed customer account', CLOSED_CUSTOMER],
    ];

    it.each(misses)('refuses to issue to %s and spends nothing', async (_label, customer) => {
      for (const minor of [1n, issueCap + 1n]) {
        const result = await new IssueAdminCredit(gate, deps).execute(adminCtx(MAKER), {
          customerAccountId: customer,
          amount: amount(minor),
          reasonCode: 'goodwill',
          idempotencyKey: key(),
        });
        expect(result).toEqual({ ok: false, error: { code: 'wallet.customer-not-found' } });
      }
      expect(stepUpAsked).toEqual([]);
      expect(credits.rows.size).toBe(0);
      expect(credits.dayLocks).toEqual([]);
      expect(wallet.journals).toHaveLength(0);
      expect(audit.entries).toHaveLength(0);
    });

    it.each(misses)('refuses the customer read of %s', async (_label, customer) => {
      expect(
        await new ViewCustomerWallet(gate, deps).execute(adminCtx(MAKER), {
          customerAccountId: customer,
        }),
      ).toEqual({ ok: false, error: { code: 'wallet.customer-not-found' } });
    });

    it('checks again at approval: a customer closed since leaves the request pending, unspent', async () => {
      const request = await pendingOf(issueCap + 1n);
      stepUpAsked = [];
      audit.entries.length = 0;
      customers.accounts.get(CUSTOMER)!.status = 'disabled';
      expect(await approve(request.id)).toEqual({
        ok: false,
        error: { code: 'wallet.customer-not-found' },
      });
      expect(stepUpAsked).toEqual([]);
      expect(credits.rows.get(request.id)).toMatchObject({ status: 'pending', journalId: null });
      expect(wallet.journals).toHaveLength(0);
      expect(audit.entries).toHaveLength(0);
      // A checker can still close it as the wrong customer.
      expect(await reject(request.id, CHECKER, 'wrong-customer')).toMatchObject({
        ok: true,
        value: { status: 'rejected', decisionReason: 'wrong-customer' },
      });
    });

    it.each([['unavailable'], ['throw'], ['denied']] as const)(
      'fails closed when identity answers %s, and spends nothing',
      async (failure) => {
        const pending = await pendingOf(issueCap + 1n);
        stepUpAsked = [];
        customers.failWith = failure;
        const code = failure === 'denied' ? 'access.denied' : 'access.unavailable';
        expect(await issue(1n)).toEqual({ ok: false, error: { code } });
        expect(await approve(pending.id)).toEqual({ ok: false, error: { code } });
        expect(
          await new ViewCustomerWallet(gate, deps).execute(adminCtx(MAKER), {
            customerAccountId: CUSTOMER,
          }),
        ).toEqual({ ok: false, error: { code } });
        expect(stepUpAsked).toEqual([]);
        expect(credits.rows.size).toBe(1);
        expect(wallet.journals).toHaveLength(0);
      },
    );
  });

  describe('reads', () => {
    it('refuses an acting-as session on both reads (review S4)', async () => {
      const context = adminCtx(MAKER);
      const actingAsCtx = {
        ...context,
        actor: { ...context.actor, actingAs: { adminAccountId: MAKER } },
      } as unknown as CallContext;
      expect(await listAdminCredits(deps, actingAsCtx, {})).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(await viewCustomerWallet(deps, actingAsCtx, { customerAccountId: CUSTOMER })).toEqual({
        ok: false,
        error: { code: 'access.denied' },
      });
      expect(customers.asked).toEqual([]);
    });

    it('lists pending, decided and granted requests, newest first, by page', async () => {
      const first = await pendingOf(issueCap + 1n);
      clock.set(T0.add({ minutes: 1 }));
      const second = await pendingOf(issueCap + 2n);
      clock.set(T0.add({ minutes: 2 }));
      await issue(1n, { by: CHECKER });
      await reject(first.id);
      const list = new ListAdminCreditRequests(gate, deps);
      expect(await list.execute(adminCtx(CHECKER), {})).toMatchObject({
        ok: true,
        value: { entries: [{ id: second.id }], nextCursor: null },
      });
      expect(await list.execute(adminCtx(CHECKER), { status: 'decided' })).toMatchObject({
        ok: true,
        value: { entries: [{ id: first.id, status: 'rejected' }] },
      });
      expect(await list.execute(adminCtx(CHECKER), { status: 'granted' })).toMatchObject({
        ok: true,
        value: { entries: [{ status: 'granted', requestedBy: CHECKER }] },
      });
      await reject(second.id);
      const page = await list.execute(adminCtx(CHECKER), { status: 'decided', limit: 1 });
      expect(page).toMatchObject({ ok: true, value: { entries: [{ id: second.id }] } });
      if (!page.ok) return;
      expect(
        await list.execute(adminCtx(CHECKER), {
          status: 'decided',
          limit: 1,
          cursor: page.value.nextCursor,
        }),
      ).toMatchObject({ ok: true, value: { entries: [{ id: first.id }], nextCursor: null } });
      expect(
        await list.execute(adminCtx(CHECKER), { status: 'all', limit: 0, cursor: 'x' }),
      ).toEqual({
        ok: false,
        error: {
          code: 'validation.failed',
          fields: [
            { path: 'status', code: 'value' },
            { path: 'limit', code: 'range' },
            { path: 'cursor', code: 'format' },
          ],
        },
      });
    });

    it("summarises a customer's wallet and the caller's caps for the issuing screen", async () => {
      const view = new ViewCustomerWallet(gate, deps);
      expect(await view.execute(adminCtx(MAKER), { customerAccountId: CUSTOMER })).toEqual({
        ok: true,
        value: {
          customerAccountId: CUSTOMER,
          currency,
          marketStatus: 'active',
          accountStatus: 'none',
          available: 0n,
          held: 0n,
          balanceCap,
          roomUnderCap: balanceCap,
          issueCap,
          dailyCap,
          usedToday: 0n,
        },
      });
      await issue(issueCap);
      await pendingOf(issueCap + 1n);
      expect(await view.execute(adminCtx(MAKER), { customerAccountId: CUSTOMER })).toMatchObject({
        ok: true,
        value: {
          accountStatus: 'active',
          available: issueCap,
          roomUnderCap: balanceCap - issueCap,
          usedToday: issueCap + issueCap + 1n,
        },
      });
      expect(await view.execute(adminCtx(MAKER), { customerAccountId: 'x' })).toMatchObject({
        ok: false,
        error: { code: 'validation.failed' },
      });
    });
  });
});
