import { err, ok, parseId, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id, Money, Result } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { AccountDeletionCancelled, AccountDeletionCompleted } from '../domain/audit';
import { AccountDeletionRequested } from '../domain/audit';
import type { AccountDeletionDependencies } from './account-deletion-dependencies';
import { DELETION_BATCH_SIZE } from './account-deletion-flow';
import { CLAIM_STALE_AFTER_MINUTES } from '../domain/account-deletion-request';
import {
  MemoryAccountDeletionRequests,
  MemoryAccountDeletionSettings,
  RecordingAudit,
  RecordingOutbox,
} from './testing/in-memory-account-deletion';
import { InMemoryAddresses } from './testing/in-memory-address-book';
import { CancelAccountDeletion } from './use-cases/cancel-account-deletion.use-case';
import { ExecuteAccountDeletions } from './use-cases/execute-account-deletions.use-case';
import { RequestAccountDeletion } from './use-cases/request-account-deletion.use-case';
import { ViewAccountDeletionRequest } from './use-cases/view-account-deletion-request.use-case';
import { CustomersAccountDeletionFacadeImplementation } from '../presentation/customers-account-deletion.facade';

// The buyer deletion flow (package 5b) in memory on both Market fixtures: the request with the
// setting guard, the typed blockers, the one pending request, the wait, the cancel, a setting
// switched off afterwards, and the executor with its repeat-safe steps.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-26T10:00:00Z');
const id = <T extends string>(n: number): Id<T> => {
  const parsed = parseId(`01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}`);
  if (!parsed.ok) throw new Error('bad id');
  return parsed.value as Id<T>;
};
const ADMIN = id<'Account'>(0xad);
const BUYER = id<'Account'>(0xb1);
const OTHER_BUYER = id<'Account'>(0xb2);
const SESSION = id<'Session'>(0x61);
const money = (amount: bigint, currency = 'AUD'): Money => ({ amount, currency });
const idle = { openOrders: 0, pendingRefunds: 0 };

/** The four facades the flow asks, each answer set by the test and every call recorded. */
class Facades {
  obligations: Result<{ openOrders: number; pendingRefunds: number }, { code: 'access.denied' }> =
    ok(idle);
  balance: Result<{ available: Money; held: Money }, { code: 'wallet.unavailable' }> = ok({
    available: money(0n),
    held: money(0n),
  });
  endSessions: Result<{ revokedSessions: number }, { code: 'session.invalid' }> = ok({
    revokedSessions: 2,
  });
  endAll: Result<{ revokedSessions: number }, { code: 'access.denied' }> = ok({
    revokedSessions: 1,
  });
  /** Runs when the sessions are ended: lets a test make an order appear at that moment. */
  onEndAll: (() => void) | null = null;
  exists: Result<{ exists: boolean }, { code: 'access.denied' }> = ok({ exists: true });
  readonly endAllFor: Id<'AccountDeletionRequest'>[] = [];
  readonly erasedFor: Id<'AccountDeletionRequest'>[] = [];
  eraseAnswer: 'erased' | 'already-erased' | 'throw' = 'erased';
  forgetOk = true;
  readonly calls: string[] = [];
  readonly contexts: CallContext[] = [];

  readonly ordering = {
    ownOpenObligations: (context: CallContext) => {
      this.calls.push('ordering.own');
      this.contexts.push(context);
      return Promise.resolve(this.obligations);
    },
    openObligationsOf: (context: CallContext, accountId: Id<'Account'>) => {
      this.calls.push(`ordering.of:${accountId}`);
      this.contexts.push(context);
      return Promise.resolve(this.obligations);
    },
  };
  readonly wallet = {
    ownBalanceOf: (context: CallContext) => {
      this.calls.push('wallet.own');
      this.contexts.push(context);
      return Promise.resolve(this.balance);
    },
    balanceOf: (context: CallContext, accountId: Id<'Account'>) => {
      this.calls.push(`wallet.of:${accountId}`);
      this.contexts.push(context);
      return Promise.resolve(this.balance);
    },
  };
  readonly identity = {
    endOtherCustomerSessions: (context: CallContext) => {
      this.calls.push('identity.end-sessions');
      this.contexts.push(context);
      return Promise.resolve(this.endSessions);
    },
    customerAccountExists: (_context: CallContext, accountId: Id<'Account'>) => {
      this.calls.push(`identity.exists:${accountId}`);
      return Promise.resolve(this.exists);
    },
    endAllCustomerSessions: (
      context: CallContext,
      accountId: Id<'Account'>,
      requestId: Id<'AccountDeletionRequest'>,
    ) => {
      this.endAllFor.push(requestId);
      this.calls.push(`identity.end-all:${accountId}`);
      this.contexts.push(context);
      this.onEndAll?.();
      return Promise.resolve(this.endAll);
    },
    eraseCustomerAccount: (
      _context: CallContext,
      accountId: Id<'Account'>,
      requestId: Id<'AccountDeletionRequest'>,
    ) => {
      this.calls.push(`identity.erase:${accountId}`);
      this.erasedFor.push(requestId);
      if (this.eraseAnswer === 'throw') return Promise.reject(new Error('boom'));
      return Promise.resolve(ok({ code: this.eraseAnswer }));
    },
  };
  readonly reviews = {
    detachAuthor: (_context: CallContext, accountId: Id<'Account'>) => {
      this.calls.push(`reviews.detach:${accountId}`);
      return Promise.resolve(ok({ reviews: 1, ratings: 1 }));
    },
  };
  readonly engagement = {
    forgetAccount: (_context: CallContext, accountId: Id<'Account'>) => {
      this.calls.push(`engagement.forget:${accountId}`);
      return Promise.resolve(this.forgetOk ? ok({ events: 3 }) : err({ code: 'access.denied' }));
    },
  };
}

describe.each(TEST_MARKET_IDS)('buyer account deletion flow in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const other = testMarketContext(
    TEST_MARKET_IDS.find((m) => m !== code)!,
    'default',
  );
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  let clock: FixedClock;
  let deps: AccountDeletionDependencies;
  let facades: Facades;
  let requests: MemoryAccountDeletionRequests;
  let settings: MemoryAccountDeletionSettings;
  let addresses: InMemoryAddresses;
  let audit: RecordingAudit;
  let outbox: RecordingOutbox;
  let units: FakeUnitOfWork;

  const buyer = (accountId = BUYER, target = market) =>
    testCallContext(
      target,
      testAuthenticatedActor(target, {
        population: 'customer',
        accountId,
        sessionId: SESSION,
        sellerId: null,
      }),
      'deletion-buyer-abcd',
    );
  const adminContext = () =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'admin',
        accountId: ADMIN,
        sessionId: SESSION,
        sellerId: null,
      }),
      'deletion-admin-abcd',
    );
  const system = (target = market) => testCallContext(target, 'system', 'deletion-system-abcd');

  const turnOn = (days = 30, target = market) =>
    settings.rows.push({
      market: target.marketId,
      version: settings.rows.filter((r) => r.market === target.marketId).length + 1,
      settings: { enabled: true, waitingPeriodDays: days },
      changedAt: T0,
      changedBy: ADMIN,
      reason: 'test',
    });
  const turnOff = (target = market) =>
    settings.rows.push({
      market: target.marketId,
      version: settings.rows.filter((r) => r.market === target.marketId).length + 1,
      settings: { enabled: false, waitingPeriodDays: 30 },
      changedAt: T0,
      changedBy: ADMIN,
      reason: 'test',
    });

  const ask = (context = buyer(), body: unknown = { confirm: true }) =>
    new RequestAccountDeletion(gate, deps).execute(context, body as { confirm: unknown });
  const current = (context = buyer()) =>
    new ViewAccountDeletionRequest(gate, deps).execute(context, {});
  const cancel = (context = buyer()) =>
    new CancelAccountDeletion(gate, deps).execute(context, { reason: 'customer' });
  const run = (context = system()) => new ExecuteAccountDeletions(gate, deps).execute(context, {});
  const rowsOf = (accountId = BUYER, target = market) =>
    [...requests.rows.values()].filter(
      (r) => r.accountId === accountId && r.market === target.marketId,
    );

  beforeEach(() => {
    clock = new FixedClock(T0);
    facades = new Facades();
    requests = new MemoryAccountDeletionRequests();
    settings = new MemoryAccountDeletionSettings();
    addresses = new InMemoryAddresses();
    audit = new RecordingAudit();
    outbox = new RecordingOutbox();
    units = new FakeUnitOfWork();
    deps = {
      unitOfWork: units,
      requests,
      addresses,
      accountDeletionSettings: settings,
      ids: new SequenceIdGenerator(clock),
      clock,
      audit,
      outbox,
      identity: facades.identity,
      wallet: facades.wallet,
      ordering: facades.ordering,
      engagement: facades.engagement,
      reviews: facades.reviews,
    };
  });

  describe('the request', () => {
    it('is refused while the Market has deletion off, before any module is asked', async () => {
      expect(await ask()).toEqual(err({ code: 'customers.account-deletion-disabled' }));
      expect(facades.calls).toEqual([]);
      expect(rowsOf()).toEqual([]);
      expect(audit.entries).toEqual([]);
      expect(outbox.events).toEqual([]);
    });

    it('is refused when the setting was switched off again', async () => {
      turnOn();
      turnOff();
      expect(await ask()).toEqual(err({ code: 'customers.account-deletion-disabled' }));
    });

    it('needs confirm: true and asks nothing without it', async () => {
      turnOn();
      for (const body of [{}, { confirm: false }, { confirm: 'true' }, null]) {
        expect(await ask(buyer(), body)).toEqual({
          ok: false,
          error: { code: 'validation.failed', fields: [{ path: 'confirm', code: 'required' }] },
        });
      }
      expect(facades.calls).toEqual([]);
    });

    it('is for the signed-in buyer only: not an admin, not an acting-as session', async () => {
      turnOn();
      expect(await ask(adminContext())).toEqual(err({ code: 'access.denied' }));
      const actingAs = {
        ...buyer(),
        actor: { ...buyer().actor, actingAs: { adminAccountId: ADMIN } },
      } as unknown as CallContext;
      expect(await ask(actingAs)).toEqual(err({ code: 'access.denied' }));
      expect(facades.calls).toEqual([]);
    });

    it('schedules at now plus the waiting period in force and records audit and event', async () => {
      turnOn(14);
      const made = await ask();
      const scheduledFor = T0.add({ hours: 14 * 24 });
      expect(made).toEqual(
        ok({ status: 'pending', requestedAt: T0, scheduledFor, waitingPeriodDays: 14 }),
      );
      const [row] = rowsOf();
      expect(row).toMatchObject({ status: 'pending', waitingPeriodDays: 14, scheduledFor });
      expect(audit.entries).toEqual([
        AccountDeletionRequested.entry(row!.id, {
          after: { waitingPeriodDays: 14, scheduledFor },
        }),
      ]);
      expect(outbox.events).toHaveLength(1);
      expect(outbox.events[0]).toMatchObject({
        type: 'customers.account-deletion-requested.v1',
        aggregateId: row!.id,
        aggregateVersion: 1,
        payload: { waitingPeriodDays: 14, scheduledFor },
      });
      // The unit that wrote it is serializable.
      expect(units.units.some((u) => u.options.isolation === 'serializable')).toBe(true);
    });

    it('keeps the period of its own Market and never reads another Market', async () => {
      turnOn(10);
      turnOn(60, other);
      const mine = await ask();
      const theirs = await ask(buyer(BUYER, other));
      expect(mine.ok && mine.value.waitingPeriodDays).toBe(10);
      expect(theirs.ok && theirs.value.waitingPeriodDays).toBe(60);
      expect(rowsOf(BUYER, market)).toHaveLength(1);
      expect(rowsOf(BUYER, other)).toHaveLength(1);
    });

    it('ends the other sessions through identity with the caller context unchanged', async () => {
      turnOn();
      const context = buyer();
      await ask(context);
      expect(facades.calls).toContain('identity.end-sessions');
      expect(facades.contexts.at(-1)).toBe(context);
    });

    it('stays committed when identity cannot end the other sessions', async () => {
      turnOn();
      facades.endSessions = err({ code: 'session.invalid' });
      expect((await ask()).ok).toBe(true);
      expect(rowsOf()).toHaveLength(1);
    });

    it('refuses a second pending request and keeps one row', async () => {
      turnOn();
      expect((await ask()).ok).toBe(true);
      expect(await ask()).toEqual(err({ code: 'customers.account-deletion-already-requested' }));
      expect(rowsOf()).toHaveLength(1);
      expect(outbox.events).toHaveLength(1);
    });

    it('two buyers each have their own pending request', async () => {
      turnOn();
      expect((await ask()).ok).toBe(true);
      expect((await ask(buyer(OTHER_BUYER))).ok).toBe(true);
    });

    it.each([
      ['open orders', { openOrders: 2, pendingRefunds: 0 }, [{ code: 'open-orders', count: 2 }]],
      [
        'pending refunds',
        { openOrders: 0, pendingRefunds: 1 },
        [{ code: 'pending-refunds', count: 1 }],
      ],
      [
        'both',
        { openOrders: 1, pendingRefunds: 3 },
        [
          { code: 'open-orders', count: 1 },
          { code: 'pending-refunds', count: 3 },
        ],
      ],
    ] as const)(
      'lists %s as a typed blocker and writes nothing',
      async (_name, counts, blockers) => {
        turnOn();
        facades.obligations = ok({ ...counts });
        expect(await ask()).toEqual(err({ code: 'customers.account-deletion-blocked', blockers }));
        expect(rowsOf()).toEqual([]);
        expect(audit.entries).toEqual([]);
        expect(facades.calls).not.toContain('identity.end-sessions');
      },
    );

    it.each([
      ['available', { available: money(1n), held: money(0n) }],
      ['held', { available: money(0n), held: money(250n) }],
    ] as const)('a wallet balance (%s) above zero blocks', async (_name, balance) => {
      turnOn();
      facades.balance = ok(balance);
      expect(await ask()).toEqual(
        err({ code: 'customers.account-deletion-blocked', blockers: [{ code: 'wallet-balance' }] }),
      );
    });

    it('lists every blocker together, in a fixed order', async () => {
      turnOn();
      facades.obligations = ok({ openOrders: 1, pendingRefunds: 1 });
      facades.balance = ok({ available: money(5n), held: money(0n) });
      const refused = await ask();
      expect(refused).toEqual(
        err({
          code: 'customers.account-deletion-blocked',
          blockers: [
            { code: 'open-orders', count: 1 },
            { code: 'pending-refunds', count: 1 },
            { code: 'wallet-balance' },
          ],
        }),
      );
    });

    it('fails closed when a module cannot answer', async () => {
      turnOn();
      facades.balance = err({ code: 'wallet.unavailable' });
      expect(await ask()).toEqual(err({ code: 'customers.unavailable' }));
      facades.balance = ok({ available: money(0n), held: money(0n) });
      facades.obligations = err({ code: 'access.denied' });
      expect(await ask()).toEqual(err({ code: 'customers.unavailable' }));
      expect(rowsOf()).toEqual([]);
    });

    it('carries no account id, email or name in any event or audit field', async () => {
      turnOn();
      await ask();
      const text = JSON.stringify([outbox.events, audit.entries]);
      expect(text).not.toContain(BUYER);
    });
  });

  describe('the current request and the cancel', () => {
    it('reads the pending request, else not found', async () => {
      turnOn();
      expect(await current()).toEqual(
        err({ code: 'customers.account-deletion-request-not-found' }),
      );
      await ask();
      expect(await current()).toEqual(
        ok({
          status: 'pending',
          requestedAt: T0,
          scheduledFor: T0.add({ hours: 720 }),
          waitingPeriodDays: 30,
        }),
      );
      expect(units.units.at(-1)?.options).toEqual({ readOnly: true });
      // Another buyer and another Market see nothing of it.
      expect((await current(buyer(OTHER_BUYER))).ok).toBe(false);
      expect((await current(buyer(BUYER, other))).ok).toBe(false);
      expect((await current(adminContext())).ok).toBe(false);
    });

    it('refuses an acting-as session, as the other routes do', async () => {
      turnOn();
      await ask();
      const actingAs = {
        ...buyer(),
        actor: { ...buyer().actor, actingAs: { adminAccountId: ADMIN } },
      } as unknown as CallContext;
      expect(await current(actingAs)).toEqual(err({ code: 'access.denied' }));
    });

    it('shows a claimed request as executing, and refuses to cancel it', async () => {
      turnOn(7);
      await ask();
      clock.set(T0.add({ hours: 7 * 24 }));
      facades.onEndAll = () => undefined;
      const [row] = rowsOf();
      await requests.claim(market, row!.id, clock.now(), clock.now().subtract({ minutes: 15 }));
      expect(await current()).toEqual(
        ok({
          status: 'executing',
          requestedAt: T0,
          scheduledFor: T0.add({ hours: 7 * 24 }),
          waitingPeriodDays: 7,
        }),
      );
      const auditBefore = audit.entries.length;
      expect(await cancel()).toEqual(err({ code: 'customers.account-deletion-in-progress' }));
      expect(rowsOf()[0]?.status).toBe('executing');
      expect(audit.entries).toHaveLength(auditBefore);
      expect(outbox.events.map((e) => e.type)).not.toContain(
        'customers.account-deletion-cancelled.v1',
      );
      // The sign-in facade is refused the same way, and a new request is still refused.
      const facade = new CustomersAccountDeletionFacadeImplementation(
        new CancelAccountDeletion(gate, deps),
      );
      expect(await facade.cancelPendingOnSignIn(buyer())).toEqual(
        err({ code: 'customers.account-deletion-in-progress' }),
      );
      expect(await ask()).toEqual(err({ code: 'customers.account-deletion-already-requested' }));
    });

    it('answers in progress when the job claims the request between the read and the cancel', async () => {
      turnOn(7);
      await ask();
      clock.set(T0.add({ hours: 7 * 24 }));
      const [row] = rowsOf();
      requests.beforeNextTransition = () => {
        void requests.claim(market, row!.id, clock.now(), clock.now().subtract({ minutes: 15 }));
      };
      expect(await cancel()).toEqual(err({ code: 'customers.account-deletion-in-progress' }));
      expect(rowsOf()[0]?.status).toBe('executing');
      expect(outbox.events.map((e) => e.type)).not.toContain(
        'customers.account-deletion-cancelled.v1',
      );
    });

    it('cancels during the wait with an audit row and a second event', async () => {
      turnOn();
      await ask();
      const [row] = rowsOf();
      expect(await cancel()).toEqual(ok({ code: 'cancelled' }));
      expect(rowsOf()[0]).toMatchObject({ status: 'cancelled', cancelReason: 'customer' });
      expect(audit.entries.at(-1)).toEqual(
        AccountDeletionCancelled.entry(row!.id, { after: { reason: 'customer' } }),
      );
      expect(outbox.events.at(-1)).toMatchObject({
        type: 'customers.account-deletion-cancelled.v1',
        aggregateId: row!.id,
        aggregateVersion: 2,
        payload: { reason: 'customer' },
      });
      expect(await current()).toEqual(
        err({ code: 'customers.account-deletion-request-not-found' }),
      );
    });

    it('answers not found when there is nothing to cancel, and cancels only its own', async () => {
      turnOn();
      expect(await cancel()).toEqual(err({ code: 'customers.account-deletion-request-not-found' }));
      await ask();
      expect(await cancel(buyer(OTHER_BUYER))).toEqual(
        err({ code: 'customers.account-deletion-request-not-found' }),
      );
      expect(await cancel(buyer(BUYER, other))).toEqual(
        err({ code: 'customers.account-deletion-request-not-found' }),
      );
      expect(await cancel(adminContext())).toEqual(err({ code: 'access.denied' }));
      expect(rowsOf()[0]?.status).toBe('pending');
    });

    it('lets the buyer ask again after a cancel', async () => {
      turnOn();
      await ask();
      await cancel();
      expect((await ask()).ok).toBe(true);
      expect(
        rowsOf()
          .map((r) => r.status)
          .sort(),
      ).toEqual(['cancelled', 'pending']);
    });

    it('the sign-in facade cancels with the reason sign-in', async () => {
      turnOn();
      await ask();
      const facade = new CustomersAccountDeletionFacadeImplementation(
        new CancelAccountDeletion(gate, deps),
      );
      expect(await facade.cancelPendingOnSignIn(buyer())).toEqual(ok({ code: 'cancelled' }));
      expect(rowsOf()[0]).toMatchObject({ status: 'cancelled', cancelReason: 'sign-in' });
    });
  });

  describe('the executor', () => {
    const seedAddress = (accountId: Id<'Account'>, n: number, target = market) =>
      addresses.insert(target, {
        id: id<'CustomerAddress'>(0xa000 + n),
        accountId,
        sealed: 'v1.sealed',
        countryCode: 'AU',
        isDefault: false,
        createdAt: T0,
        updatedAt: T0,
      });

    it('does nothing before the date', async () => {
      turnOn(7);
      await ask();
      clock.advance(Temporal.Duration.from({ hours: 7 * 24 - 1 }));
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 0 }));
      expect(rowsOf()[0]?.status).toBe('pending');
      expect(facades.calls.some((c) => c.startsWith('identity.erase'))).toBe(false);
    });

    it('is for the system actor only', async () => {
      expect(await run(adminContext())).toEqual(err({ code: 'access.denied' }));
      expect(await run(buyer())).toEqual(err({ code: 'access.denied' }));
    });

    async function due(days = 7) {
      turnOn(days);
      await ask();
      facades.calls.length = 0;
      clock.set(T0.add({ hours: days * 24 }));
    }

    it('erases the account, forgets engagement, deletes addresses and marks it completed', async () => {
      await due();
      await seedAddress(BUYER, 1);
      await seedAddress(BUYER, 2);
      await seedAddress(OTHER_BUYER, 3);
      const outcome = await run();
      expect(outcome).toEqual(ok({ completed: 1, blocked: 0, failed: 0 }));
      // The blockers under the system; the claim; every session ended; the blockers once more
      // (nothing can change now); then the key destroyed, then engagement and reviews.
      expect(facades.calls).toEqual([
        `ordering.of:${BUYER}`,
        `wallet.of:${BUYER}`,
        `identity.end-all:${BUYER}`,
        `ordering.of:${BUYER}`,
        `wallet.of:${BUYER}`,
        `identity.erase:${BUYER}`,
        `engagement.forget:${BUYER}`,
        `reviews.detach:${BUYER}`,
      ]);
      expect(await addresses.list(market, BUYER)).toEqual([]);
      expect(await addresses.list(market, OTHER_BUYER)).toHaveLength(1);
      const [row] = rowsOf();
      expect(row?.status).toBe('completed');
      // identity's audit row names the request that asked for the erasure.
      expect(facades.erasedFor).toEqual([row!.id]);
      expect(audit.entries.at(-1)).toEqual(
        AccountDeletionCompleted.entry(row!.id, { after: { waitingPeriodDays: 7 } }),
      );
      expect(outbox.events.at(-1)).toMatchObject({
        type: 'customers.account-deletion-completed.v1',
        aggregateId: row!.id,
        aggregateVersion: 2,
        payload: { waitingPeriodDays: 7 },
      });
    });

    it('is safe to run again: nothing more is done and no second event is written', async () => {
      await due();
      await run();
      const events = outbox.events.length;
      const calls = facades.calls.length;
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 0 }));
      expect(outbox.events).toHaveLength(events);
      expect(facades.calls).toHaveLength(calls);
    });

    const staleClaim = () =>
      clock.advance(Temporal.Duration.from({ minutes: CLAIM_STALE_AFTER_MINUTES }));

    it('repeats the steps after a failure once the claim is stale, and already-erased is fine', async () => {
      await due();
      facades.forgetOk = false;
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 1 }));
      // Claimed and left executing: the buyer can no longer cancel it.
      expect(rowsOf()[0]).toMatchObject({ status: 'executing', claimedAt: clock.now() });
      expect(await cancel()).toEqual(err({ code: 'customers.account-deletion-in-progress' }));
      // A fresh claim is not taken by the next run...
      facades.forgetOk = true;
      facades.eraseAnswer = 'already-erased';
      facades.calls.length = 0;
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 0 }));
      expect(facades.calls).toEqual([]);
      // ...a stale one is: the key is already destroyed, the rest goes through.
      staleClaim();
      expect(await run()).toEqual(ok({ completed: 1, blocked: 0, failed: 0 }));
      expect(rowsOf()[0]?.status).toBe('completed');
    });

    it('a failed lock-out of the sessions leaves the request executing and erases nothing', async () => {
      await due();
      facades.endAll = err({ code: 'access.denied' });
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 1 }));
      expect(facades.calls.some((c) => c.startsWith('identity.erase'))).toBe(false);
      expect(rowsOf()[0]?.status).toBe('executing');
    });

    it('two runs at once: only one claims the request and does the erase work', async () => {
      await due();
      const [a, b] = await Promise.all([run(), run()]);
      const outcomes = [a, b].map((r) => (r.ok ? r.value : null));
      expect(outcomes.filter((o) => o?.completed === 1)).toHaveLength(1);
      expect(outcomes.reduce((n, o) => n + (o?.failed ?? 0), 0)).toBe(0);
      expect(facades.calls.filter((c) => c.startsWith('identity.erase'))).toHaveLength(1);
      expect(facades.calls.filter((c) => c.startsWith('identity.end-all'))).toHaveLength(1);
      expect(
        outbox.events.filter((e) => e.type === 'customers.account-deletion-completed.v1'),
      ).toHaveLength(1);
      expect(rowsOf()[0]?.status).toBe('completed');
    });

    it('a cancel that lands between the executor read and its claim wins: nothing is erased', async () => {
      await due();
      const [row] = rowsOf();
      requests.beforeNextTransition = () => {
        void requests.cancel(market, row!.id, 'customer', clock.now());
      };
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 0 }));
      expect(rowsOf()[0]?.status).toBe('cancelled');
      expect(facades.calls.some((c) => c.startsWith('identity.'))).toBe(false);
    });

    it('a request claimed by a live run is left alone; a stale claim is taken by exactly one run', async () => {
      await due();
      const [row] = rowsOf();
      await requests.claim(market, row!.id, clock.now(), clock.now().subtract({ minutes: 15 }));
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 0 }));
      expect(facades.calls).toEqual([]);
      staleClaim();
      const [a, b] = await Promise.all([run(), run()]);
      expect([a, b].map((r) => (r.ok ? r.value.completed : -1)).sort()).toEqual([0, 1]);
      expect(facades.calls.filter((c) => c.startsWith('identity.erase'))).toHaveLength(1);
    });

    it('gives the claim back when a blocker appears after the sessions are ended', async () => {
      await due();
      // An order lands in the last moment before the lock-out takes effect.
      facades.onEndAll = () => {
        facades.obligations = ok({ openOrders: 1, pendingRefunds: 0 });
      };
      expect(await run()).toEqual(ok({ completed: 0, blocked: 1, failed: 0 }));
      expect(facades.calls.some((c) => c.startsWith('identity.erase'))).toBe(false);
      // Pending again and cancellable, with no claim.
      expect(rowsOf()[0]).toMatchObject({ status: 'pending', claimedAt: null });
      facades.onEndAll = null;
      facades.obligations = ok(idle);
      expect(await run()).toEqual(ok({ completed: 1, blocked: 0, failed: 0 }));
    });

    /** A claim left executing by a run that died after it, made stale. */
    async function resumable() {
      await due();
      facades.forgetOk = false;
      await run();
      facades.forgetOk = true;
      facades.calls.length = 0;
      facades.erasedFor.length = 0;
      facades.endAllFor.length = 0;
      staleClaim();
    }

    it('hands a resumed claim back to pending when a blocker appears and the account still exists', async () => {
      await resumable();
      facades.obligations = ok({ openOrders: 1, pendingRefunds: 0 });
      expect(await run()).toEqual(ok({ completed: 0, blocked: 1, failed: 0 }));
      expect(facades.calls).toContain(`identity.exists:${BUYER}`);
      expect(rowsOf()[0]).toMatchObject({ status: 'pending', claimedAt: null });
      expect(facades.calls.some((c) => c.startsWith('identity.erase'))).toBe(false);
    });

    it('never hands a claim back once the account is erased: it finishes the remaining steps', async () => {
      await resumable();
      facades.exists = ok({ exists: false });
      facades.eraseAnswer = 'already-erased';
      facades.obligations = ok({ openOrders: 1, pendingRefunds: 0 });
      expect(await run()).toEqual(ok({ completed: 1, blocked: 0, failed: 0 }));
      expect(rowsOf()[0]?.status).toBe('completed');
      expect(facades.erasedFor).toEqual([rowsOf()[0]!.id]);
      expect(facades.endAllFor).toEqual([rowsOf()[0]!.id]);
    });

    it('also finishes when the blocker only shows after the sessions are ended', async () => {
      await resumable();
      facades.exists = ok({ exists: false });
      facades.eraseAnswer = 'already-erased';
      facades.onEndAll = () => {
        facades.obligations = ok({ openOrders: 1, pendingRefunds: 0 });
      };
      expect(await run()).toEqual(ok({ completed: 1, blocked: 0, failed: 0 }));
      expect(rowsOf()[0]?.status).toBe('completed');
    });

    it('leaves a resumed claim executing when identity cannot say whether the account exists', async () => {
      await resumable();
      facades.exists = err({ code: 'access.denied' });
      facades.obligations = ok({ openOrders: 1, pendingRefunds: 0 });
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 1 }));
      expect(rowsOf()[0]?.status).toBe('executing');
      expect(facades.calls.some((c) => c.startsWith('identity.erase'))).toBe(false);
    });

    it('does not complete under a claim another run took over', async () => {
      await due();
      const [row] = rowsOf();
      const claimedAt = clock.now();
      await requests.claim(market, row!.id, claimedAt, claimedAt.subtract({ minutes: 15 }));
      const later = claimedAt.add({ minutes: 20 });
      await requests.claim(market, row!.id, later, later.subtract({ minutes: 15 }));
      expect(await requests.complete(market, row!.id, claimedAt, later)).toBe(false);
      expect(await requests.complete(market, row!.id, later, later)).toBe(true);
    });

    it('a cancelled request is still cancellable after a released claim', async () => {
      await due();
      facades.onEndAll = () => {
        facades.obligations = ok({ openOrders: 1, pendingRefunds: 0 });
      };
      await run();
      expect(await cancel()).toEqual(ok({ code: 'cancelled' }));
    });

    it('a request that throws does not stop the next one', async () => {
      turnOn(7);
      await ask();
      await ask(buyer(OTHER_BUYER));
      clock.set(T0.add({ hours: 7 * 24 }));
      facades.eraseAnswer = 'throw';
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 2 }));
      facades.eraseAnswer = 'erased';
      staleClaim();
      expect(await run()).toEqual(ok({ completed: 2, blocked: 0, failed: 0 }));
    });

    it('leaves a request pending when an order, a refund or credit appeared during the wait', async () => {
      await due();
      facades.obligations = ok({ openOrders: 1, pendingRefunds: 0 });
      expect(await run()).toEqual(ok({ completed: 0, blocked: 1, failed: 0 }));
      // Found before the claim: no session ended, no erase, still pending.
      expect(facades.calls.some((c) => c.startsWith('identity.'))).toBe(false);
      expect(rowsOf()[0]?.status).toBe('pending');
      facades.obligations = ok(idle);
      facades.balance = ok({ available: money(1n), held: money(0n) });
      expect(await run()).toEqual(ok({ completed: 0, blocked: 1, failed: 0 }));
      facades.balance = ok({ available: money(0n), held: money(0n) });
      expect(await run()).toEqual(ok({ completed: 1, blocked: 0, failed: 0 }));
    });

    it('a cancelled request is never executed', async () => {
      await due();
      await cancel();
      expect(await run()).toEqual(ok({ completed: 0, blocked: 0, failed: 0 }));
      expect(facades.calls.some((c) => c.startsWith('identity.erase'))).toBe(false);
    });

    it('still runs a request that was pending when the setting was switched off', async () => {
      await due();
      turnOff();
      expect(await run()).toEqual(ok({ completed: 1, blocked: 0, failed: 0 }));
      // ...while a new request is refused.
      expect(await ask(buyer(OTHER_BUYER))).toEqual(
        err({ code: 'customers.account-deletion-disabled' }),
      );
    });

    it('works one Market at a time and takes a bounded batch', async () => {
      turnOn(7);
      turnOn(7, other);
      await ask();
      await ask(buyer(BUYER, other));
      clock.set(T0.add({ hours: 7 * 24 }));
      expect(await run(system())).toEqual(ok({ completed: 1, blocked: 0, failed: 0 }));
      expect(rowsOf(BUYER, other)[0]?.status).toBe('pending');
      expect(await run(system(other))).toEqual(ok({ completed: 1, blocked: 0, failed: 0 }));
      expect(DELETION_BATCH_SIZE).toBeGreaterThan(0);
    });
  });
});
