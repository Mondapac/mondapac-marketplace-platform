import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testAuthenticatedActor,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  accountEvent,
  FakeConnectGateway,
  FakeIdentityFacade,
  FakeOrderingFacade,
  FakeTransferGateway,
  FakeSessionReader,
  MemoryAccountStore,
  MemoryInbox,
  MemoryTransferStore,
  RecordingPaymentsAudit,
  StaticPaymentsPolicy,
  testKeyring,
  stripeSignatureHeader,
  TEST_CONNECT_WEBHOOK_SECRET,
  TEST_WEBHOOK_SECRET,
  FakeDisputeReader,
  MemoryDisputeStore,
  RecordingPaymentsOutbox,
} from '../../../../test/support/payments-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import type { AccountSnapshot } from '../domain/connected-account';
import { StripeWebhookSignature } from '../infrastructure/stripe-webhook-signature';
import type { PaymentsDependencies } from './payments-dependencies';
import { AdminListConnectedAccounts } from './use-cases/admin-list-connected-accounts.use-case';
import { AdminViewConnectedAccount } from './use-cases/admin-view-connected-account.use-case';
import { ApplyStripeEvents } from './use-cases/apply-stripe-events.use-case';
import { ConnectPayoutAccount } from './use-cases/connect-payout-account.use-case';
import { OpenPayoutAccountLink } from './use-cases/open-payout-account-link.use-case';
import { PayoutReadinessQuery } from './use-cases/payout-readiness.use-case';
import { ReceiveStripeEvent } from './use-cases/receive-stripe-event.use-case';
import { SyncPayoutSchedules } from './use-cases/sync-payout-schedules.use-case';
import { ViewPayoutAccount } from './use-cases/view-payout-account.use-case';
import { RecordingSecurityEvents } from '../../../../test/support/recording-security-events';

// The bank-change waiting period, the payout pause, the recent two-step confirmation and the
// admin read of connected accounts, in memory on both Market fixtures.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const SELLER = '01990000-0000-7000-8000-0000000000b1';
const OTHER_SELLER = '01990000-0000-7000-8000-0000000000b2';
const ACCOUNT = 'acct_test_0001';
const CODE = '123456';
const EXTERNAL = {
  created: 'account.external_account.created',
  updated: 'account.external_account.updated',
  deleted: 'account.external_account.deleted',
} as const;
const HOUR = (n: number) => Temporal.Duration.from({ hours: n });

describe.each(['AU', 'ZZ'] as const)('payout account safety in market %s', (code) => {
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const actorOf = (population: 'seller' | 'admin', sellerId: string | null) =>
    testAuthenticatedActor(market, {
      population,
      accountId: '01990000-0000-7000-8000-0000000000c1' as Id<'Account'>,
      sessionId: '01990000-0000-7000-8000-0000000000d1' as Id<'Session'>,
      sellerId: sellerId as Id<'Seller'> | null,
    });
  const seller = (sellerId = SELLER): CallContext =>
    testCallContext(market, actorOf('seller', sellerId));
  const admin = testCallContext(market, actorOf('admin', null));
  const anonymous = testCallContext(market, 'anonymous', 'pay-0001-abcd');
  const system = testCallContext(market, 'system', 'pay-0002-abcd');

  let clock: FixedClock;
  let accounts: MemoryAccountStore;
  let connect: FakeConnectGateway;
  let inbox: MemoryInbox;
  let identity: FakeIdentityFacade;
  let audit: RecordingPaymentsAudit;
  let deps: PaymentsDependencies;
  const build = (policy = new StaticPaymentsPolicy(code === 'AU' ? 'AU' : 'JP')) => {
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      inbox,
      signature: new StripeWebhookSignature({ [code]: TEST_WEBHOOK_SECRET }, clock, {
        [code]: TEST_CONNECT_WEBHOOK_SECRET,
      }),
      reader: new FakeSessionReader(),
      disputeReader: new FakeDisputeReader(),
      disputes: new MemoryDisputeStore(),
      outbox: new RecordingPaymentsOutbox(),
      ordering: new FakeOrderingFacade(),
      accounts,
      connect,
      transfers: new MemoryTransferStore(),
      transferGateway: new FakeTransferGateway(),
      keyring: testKeyring(),
      policy,
      identity,
      audit,
      securityEvents: new RecordingSecurityEvents(),
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  };
  const beforeEachReset = () => {
    accounts = new MemoryAccountStore();
    connect = new FakeConnectGateway();
    inbox = new MemoryInbox();
    audit = new RecordingPaymentsAudit();
    build();
  };
  const snapshot = (fields: Partial<AccountSnapshot> = {}): AccountSnapshot => ({
    id: ACCOUNT,
    metadataMarketId: code,
    metadataSellerId: SELLER,
    detailsSubmitted: true,
    transfersActive: true,
    payoutsEnabled: true,
    requirementsDue: 0,
    requirementsPastDue: false,
    disabledReason: null,
    payoutScheduleInterval: 'daily',
    externalAccountCount: 1,
    defaultExternalAccountId: null,
    ...fields,
  });

  beforeEach(() => {
    clock = new FixedClock(T0);
    accounts = new MemoryAccountStore();
    connect = new FakeConnectGateway();
    inbox = new MemoryInbox();
    identity = new FakeIdentityFacade();
    audit = new RecordingPaymentsAudit();
    build();
  });

  const signed = (event: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(event));
    return {
      payload: body,
      signature: stripeSignatureHeader(body, clock.now(), TEST_CONNECT_WEBHOOK_SECRET),
    };
  };
  const receive = (event: Record<string, unknown>) =>
    new ReceiveStripeEvent(gate, deps).execute(anonymous, signed(event));
  const apply = () => new ApplyStripeEvents(gate, deps).execute(system, {});
  const sync = () => new SyncPayoutSchedules(gate, deps).execute(system, {});
  const view = () => new ViewPayoutAccount(gate, deps).execute(seller(), {});
  const row = () => accounts.rows.get(`${code}/${SELLER}`)!;

  /** An enabled account with its Stripe id stored. */
  const enabledAccount = async () => {
    await accounts.insert(market, SELLER, T0);
    await accounts.linkRef(market, SELLER, ACCOUNT);
    await accounts.applyRead(market, SELLER, snapshot(), 'enabled', T0.subtract({ minutes: 1 }));
    connect.readAnswer = ok(snapshot());
  };
  /** A linked account still in onboarding: never enabled, nothing recorded. */
  const pendingAccount = async () => {
    await accounts.insert(market, SELLER, T0);
    await accounts.linkRef(market, SELLER, ACCOUNT);
    connect.readAnswer = ok(snapshot());
  };
  /** The onboarding done: the first bank account is an `initial` change, the account enabled. */
  const onboarded = async () => {
    await pendingAccount();
    await bankEvent('created', 'evt_1');
  };
  /** Stores and applies one external-account event of the account at the current instant. */
  const bankEvent = async (type: keyof typeof EXTERNAL, id: string) => {
    expect(await receive(accountEvent({ id, type: EXTERNAL[type], marketId: code }))).toEqual(
      ok('recorded'),
    );
    return apply();
  };

  describe('receiving external-account events', () => {
    it('stores the three types by account id, once, and refuses a payload of another shape', async () => {
      for (const [index, type] of Object.values(EXTERNAL).entries()) {
        const event = accountEvent({ id: `evt_ext_${index}`, type, marketId: code });
        expect(await receive(event)).toEqual(ok('recorded'));
        expect(await receive(event)).toEqual(ok('duplicate'));
        expect(inbox.get(code, `evt_ext_${index}`)).toMatchObject({ type, objectId: ACCOUNT });
      }
      const wrong = accountEvent({ id: 'evt_ext_x', type: EXTERNAL.created, marketId: code });
      (wrong.data as { object: Record<string, unknown> }).object.object = 'capability';
      expect(await receive(wrong)).toEqual(err({ code: 'validation.failed' }));
      const other = accountEvent({ id: 'evt_ext_y', type: EXTERNAL.created, marketId: code });
      (other.data as { object: Record<string, unknown> }).object.account = 'acct_other_0002';
      expect(await receive(other)).toEqual(err({ code: 'validation.failed' }));
    });
  });

  describe('bank changes and the waiting period', () => {
    it('makes the first destination initial, with no waiting period and no pause', async () => {
      await pendingAccount();
      expect(await bankEvent('created', 'evt_1')).toEqual(
        ok({ applied: 1, retried: 0, problems: [] }),
      );

      expect(row()).toMatchObject({ coolingOffUntil: null, payoutsPausedUntil: null });
      expect(accounts.changes).toMatchObject([{ kind: 'initial', coolingOffUntil: null }]);
      expect(await view()).toMatchObject({
        value: { ready: true, coolingOffUntil: null, payoutsPaused: false },
      });
      expect(audit.rows.map((r) => r.action)).toEqual(['payments.payout-change.recorded']);
      expect(await sync()).toEqual(ok({ paused: 0, resumed: 0, problems: [] }));
      expect(connect.schedules).toEqual([]);
    });

    it('treats a created bank account as a change unless it is the only one on an account never enabled', async () => {
      const kinds: string[] = [];
      const cases: [string, () => Promise<void>, Partial<AccountSnapshot>][] = [
        ['onboarding', pendingAccount, {}],
        ['enabled before', enabledAccount, {}],
        ['two accounts', pendingAccount, { externalAccountCount: 2 }],
        ['unknown count', pendingAccount, { externalAccountCount: null }],
        ['none left', pendingAccount, { externalAccountCount: 0 }],
      ];
      for (const [index, [, setup, fields]] of cases.entries()) {
        beforeEachReset();
        await setup();
        connect.readAnswer = ok(snapshot(fields));
        await bankEvent('created', `evt_k${index}`);
        kinds.push(accounts.changes[0]!.kind);
      }
      expect(kinds).toEqual(['initial', 'added', 'added', 'added', 'added']);
    });

    it('starts the waiting period on a later change, reads the account again and pauses payouts once', async () => {
      await onboarded();
      clock.advance(HOUR(3));
      const changedAt = clock.now();
      await bankEvent('updated', 'evt_2');

      expect(connect.reads).toEqual([ACCOUNT, ACCOUNT]);
      const until = changedAt.add(HOUR(24));
      expect(row().coolingOffUntil?.toString()).toBe(until.toString());
      expect(row().payoutsPausedUntil?.toString()).toBe(until.toString());
      expect(accounts.changes.map((c) => c.kind)).toEqual(['initial', 'updated']);
      expect(accounts.changes.every((c) => !JSON.stringify(c).includes('acct_'))).toBe(true);

      const answered = await view();
      expect(answered).toMatchObject({
        value: { status: 'enabled', ready: false, payoutsPaused: true },
      });
      expect(answered.ok && answered.value.coolingOffUntil?.toString()).toBe(until.toString());
      expect(answered.ok && answered.value.changes.map((c) => c.kind)).toEqual([
        'updated',
        'initial',
      ]);
      expect(
        await new PayoutReadinessQuery(gate, deps).execute(system, [SELLER, OTHER_SELLER]),
      ).toEqual(
        ok([
          { sellerId: SELLER, ready: false },
          { sellerId: OTHER_SELLER, ready: false },
        ]),
      );

      // The handler wrote nothing to Stripe: the one job does, once, and records it.
      expect(connect.schedules).toEqual([]);
      expect(await sync()).toEqual(ok({ paused: 1, resumed: 0, problems: [] }));
      expect(connect.schedules).toEqual([
        {
          accountRef: ACCOUNT,
          schedule: 'manual',
          idempotencyKey: `payout-pause:${row().lastChangeId}:r1`,
        },
      ]);
      expect(row().payoutScheduleApplied).toBe('manual');
      expect(await sync()).toEqual(ok({ paused: 0, resumed: 0, problems: [] }));
      expect(connect.schedules).toHaveLength(1);
      expect(audit.rows.map((r) => r.action)).toEqual([
        'payments.payout-change.recorded',
        'payments.payout-change.recorded',
        'payments.payout-schedule.paused',
      ]);
      expect(audit.rows.every((r) => r.actorKind === 'system')).toBe(true);
    });

    it('resumes the Market schedule when the waiting period is over, and is ready again', async () => {
      await onboarded();
      await bankEvent('deleted', 'evt_2');
      await sync();
      const changeId = row().lastChangeId;

      clock.advance(HOUR(23));
      expect(await sync()).toEqual(ok({ paused: 0, resumed: 0, problems: [] }));
      expect((await view()).ok && (await view()).ok).toBe(true);
      expect(await view()).toMatchObject({ value: { ready: false, payoutsPaused: true } });

      clock.advance(HOUR(1));
      expect(await view()).toMatchObject({
        value: { ready: true, payoutsPaused: false, coolingOffUntil: null },
      });
      expect(await sync()).toEqual(ok({ paused: 0, resumed: 1, problems: [] }));
      expect(connect.schedules.at(-1)).toEqual({
        accountRef: ACCOUNT,
        schedule: 'daily',
        idempotencyKey: `payout-resume:${changeId}:r1`,
      });
      expect(row().payoutScheduleApplied).toBe('normal');
      expect(audit.rows.at(-1)?.action).toBe('payments.payout-schedule.resumed');
      expect(await sync()).toEqual(ok({ paused: 0, resumed: 0, problems: [] }));
      expect(await new PayoutReadinessQuery(gate, deps).execute(system, [SELLER])).toEqual(
        ok([{ sellerId: SELLER, ready: true }]),
      );
    });

    it('never shortens a longer waiting period', async () => {
      await pendingAccount();
      build(new StaticPaymentsPolicy(code === 'AU' ? 'AU' : 'JP', undefined, 72));
      await bankEvent('created', 'evt_1');
      await receive(accountEvent({ id: 'evt_2', type: EXTERNAL.updated, marketId: code }));
      await apply();
      const longest = row().coolingOffUntil!;
      expect(longest.toString()).toBe(T0.add(HOUR(72)).toString());

      build(new StaticPaymentsPolicy(code === 'AU' ? 'AU' : 'JP', undefined, 24));
      clock.advance(HOUR(1));
      await receive(accountEvent({ id: 'evt_3', type: EXTERNAL.created, marketId: code }));
      await apply();
      expect(row().coolingOffUntil?.toString()).toBe(longest.toString());
      expect(accounts.changes.map((c) => c.kind)).toEqual(['initial', 'updated', 'added']);
      // The row of the change keeps the waiting period in force after it.
      expect(accounts.changes[2]?.coolingOffUntil?.toString()).toBe(longest.toString());
    });

    it('keeps a Stripe failure for the next run, with the same key', async () => {
      await onboarded();
      connect.readAnswer = ok(snapshot({ payoutScheduleInterval: 'manual' }));
      await bankEvent('updated', 'evt_2');

      connect.scheduleAnswer = err({ code: 'payment.provider-unavailable' });
      expect(await sync()).toEqual(
        ok({
          paused: 0,
          resumed: 0,
          problems: [{ sellerId: SELLER, action: 'pause', code: 'payment.provider-unavailable' }],
        }),
      );
      expect(row().payoutScheduleApplied).toBeNull();
      expect(row().payoutScheduleRevision).toBe(0);
      expect(audit.rows.map((r) => r.action)).not.toContain('payments.payout-schedule.paused');
      expect(audit.rows.at(-1)).toMatchObject({
        action: 'payments.payout-pause.failed',
        actorKind: 'system',
      });

      connect.scheduleAnswer = ok(undefined);
      expect(await sync()).toEqual(ok({ paused: 1, resumed: 0, problems: [] }));
      expect(new Set(connect.schedules.map((s) => s.idempotencyKey)).size).toBe(1);
    });

    it('writes the pause again, under a new key, when a read finds Stripe undone while paused', async () => {
      await onboarded();
      connect.readAnswer = ok(snapshot({ payoutScheduleInterval: 'manual' }));
      await bankEvent('updated', 'evt_2');
      await sync();
      const changeId = row().lastChangeId;

      connect.readAnswer = ok(snapshot({ payoutScheduleInterval: 'daily' }));
      await receive(accountEvent({ id: 'evt_3', marketId: code }));
      await apply();
      expect(row()).toMatchObject({ payoutScheduleApplied: 'normal', payoutScheduleRevision: 1 });

      expect(await sync()).toEqual(ok({ paused: 1, resumed: 0, problems: [] }));
      expect(connect.schedules.map((s) => s.idempotencyKey)).toEqual([
        `payout-pause:${changeId}`,
        `payout-pause:${changeId}:r1`,
      ]);

      // A read that shows manual leaves the applied state alone.
      connect.readAnswer = ok(snapshot({ payoutScheduleInterval: 'manual' }));
      clock.advance(Temporal.Duration.from({ seconds: 5 }));
      await receive(accountEvent({ id: 'evt_4', marketId: code }));
      await apply();
      expect(row().payoutScheduleApplied).toBe('manual');
    });

    it('takes a new key after Stripe answered a write with an error, and keeps it after no answer', async () => {
      await onboarded();
      connect.readAnswer = ok(snapshot({ payoutScheduleInterval: 'manual' }));
      await bankEvent('updated', 'evt_2');
      const changeId = row().lastChangeId;

      for (const failure of [
        { code: 'payment.provider-rejected' },
        { code: 'payment.provider-unavailable', answered: true },
      ] as const) {
        connect.scheduleAnswer = err(failure);
        await sync();
      }
      expect(row().payoutScheduleRevision).toBe(2);
      // No answer at all (timeout, lost connection): the write may have happened, same key.
      connect.scheduleAnswer = err({ code: 'payment.provider-unavailable' });
      await sync();
      await sync();
      expect(row().payoutScheduleRevision).toBe(2);

      connect.scheduleAnswer = ok(undefined);
      expect(await sync()).toEqual(ok({ paused: 1, resumed: 0, problems: [] }));
      expect(connect.schedules.map((s) => s.idempotencyKey)).toEqual([
        `payout-pause:${changeId}`,
        `payout-pause:${changeId}:r1`,
        `payout-pause:${changeId}:r2`,
        `payout-pause:${changeId}:r2`,
        `payout-pause:${changeId}:r2`,
      ]);
      expect(audit.rows.filter((r) => r.action === 'payments.payout-pause.failed')).toHaveLength(4);
      // A failed resume is no pause failure.
      clock.advance(HOUR(24));
      connect.scheduleAnswer = err({ code: 'payment.provider-rejected' });
      await sync();
      expect(audit.rows.filter((r) => r.action === 'payments.payout-pause.failed')).toHaveLength(4);
      expect(row().payoutScheduleRevision).toBe(3);
    });

    it('stores a write as applied only while the latest change and revision are unchanged', async () => {
      await onboarded();
      connect.readAnswer = ok(snapshot({ payoutScheduleInterval: 'manual' }));
      await bankEvent('updated', 'evt_2');
      const auditBefore = audit.rows.length;
      // A newer change lands while Stripe takes the write.
      const realSet = connect.setPayoutSchedule.bind(connect);
      connect.setPayoutSchedule = async (...args) => {
        const answer = await realSet(...args);
        const current = row();
        accounts.rows.set(`${code}/${SELLER}`, { ...current, lastChangeId: 'newer-change' });
        return answer;
      };
      expect(await sync()).toEqual(ok({ paused: 0, resumed: 0, problems: [] }));
      expect(row().payoutScheduleApplied).toBeNull();
      expect(audit.rows).toHaveLength(auditBefore);
    });

    it('marks a re-pause whatever the applied state, only when Stripe shows a non-manual schedule', async () => {
      await onboarded();
      connect.readAnswer = ok(snapshot({ payoutScheduleInterval: 'manual' }));
      await bankEvent('updated', 'evt_2');
      // Paused, never written to Stripe (applied is null), and a read shows a daily schedule.
      expect(row().payoutScheduleApplied).toBeNull();
      connect.readAnswer = ok(snapshot({ payoutScheduleInterval: 'daily' }));
      await receive(accountEvent({ id: 'evt_3', marketId: code }));
      await apply();
      expect(row()).toMatchObject({ payoutScheduleApplied: 'normal', payoutScheduleRevision: 1 });
      // Shows manual: nothing marked.
      connect.readAnswer = ok(snapshot({ payoutScheduleInterval: 'manual' }));
      clock.advance(Temporal.Duration.from({ seconds: 5 }));
      await receive(accountEvent({ id: 'evt_4', marketId: code }));
      await apply();
      expect(row().payoutScheduleRevision).toBe(1);
    });

    it('does nothing for a Market without a normal schedule, and retries a conflicting change', async () => {
      await onboarded();
      await bankEvent('updated', 'evt_2');
      build(new StaticPaymentsPolicy(code === 'AU' ? 'AU' : 'JP', undefined, 24, null));
      expect(await sync()).toEqual(ok({ paused: 0, resumed: 0, problems: [] }));
      expect(connect.schedules).toEqual([]);

      // Another change got in between the read and the write: the event stays, nothing is kept.
      await receive(accountEvent({ id: 'evt_3', type: EXTERNAL.updated, marketId: code }));
      const realRecord = accounts.recordChange.bind(accounts);
      accounts.recordChange = () => Promise.resolve('conflict');
      expect(await apply()).toEqual(ok({ applied: 0, retried: 1, problems: [] }));
      expect(inbox.get(code, 'evt_3')?.processedAt).toBeNull();
      accounts.recordChange = realRecord;
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      expect(await apply()).toEqual(ok({ applied: 1, retried: 0, problems: [] }));
      expect(accounts.changes).toHaveLength(3);
    });

    it('refuses the job and the readiness query to every request actor', async () => {
      for (const context of [seller(), admin, anonymous]) {
        expect((await new SyncPayoutSchedules(gate, deps).execute(context, {})).ok).toBe(false);
      }
    });
  });

  describe('recent two-step confirmation', () => {
    it('checks the code before the account is stored or Stripe is called', async () => {
      const result = await new ConnectPayoutAccount(gate, deps).execute(seller(), { code: CODE });
      expect(result.ok).toBe(true);
      expect(identity.checks).toEqual([CODE]);
      expect(connect.creates).toHaveLength(1);

      const open = await new OpenPayoutAccountLink(gate, deps).execute(seller(), { code: CODE });
      expect(open).toMatchObject({ ok: true, value: { secondFactorActive: true } });
      expect(identity.checks).toEqual([CODE, CODE]);
    });

    it('refuses a seller without two-step sign-in, a wrong code, a missing code and a lock, writing nothing', async () => {
      const connectCase = new ConnectPayoutAccount(gate, deps);
      identity.secondFactorActive = false;
      expect(await connectCase.execute(seller(), { code: CODE })).toEqual(
        err({ code: 'payments.payout-account.second-factor-required' }),
      );
      expect(identity.checks).toEqual([]);

      identity.secondFactorActive = true;
      expect(await connectCase.execute(seller(), { code: '000000' })).toEqual(
        err({ code: 'second-factor.invalid' }),
      );
      expect(await connectCase.execute(seller(), {})).toEqual(
        err({ code: 'second-factor.invalid' }),
      );
      expect(await connectCase.execute(seller(), { code: 123456 })).toEqual(
        err({ code: 'second-factor.invalid' }),
      );
      identity.failure = { code: 'validation.failed', fields: [{ path: 'code', code: 'format' }] };
      expect(await connectCase.execute(seller(), { code: 'abc' })).toEqual(
        err({ code: 'second-factor.invalid' }),
      );
      identity.failure = { code: 'second-factor.locked', retryAfterSeconds: 900 };
      expect(await connectCase.execute(seller(), { code: CODE })).toEqual(
        err({ code: 'second-factor.locked', retryAfterSeconds: 900 }),
      );
      identity.failure = { code: 'second-factor.unavailable' };
      expect(await connectCase.execute(seller(), { code: CODE })).toEqual(
        err({ code: 'payments.payout-account.second-factor-required' }),
      );
      identity.failure = { code: 'access.unavailable' };
      expect(await connectCase.execute(seller(), { code: CODE })).toEqual(
        err({ code: 'payments.unavailable' }),
      );

      expect(accounts.rows.size).toBe(0);
      expect(connect.creates).toEqual([]);
      expect(connect.links).toEqual([]);
    });

    it('asks the same of the link route, and leaves an unconfigured Market before it spends a code', async () => {
      await enabledAccount();
      const open = new OpenPayoutAccountLink(gate, deps);
      identity.secondFactorActive = false;
      expect(await open.execute(seller(), { code: CODE })).toEqual(
        err({ code: 'payments.payout-account.second-factor-required' }),
      );
      identity.secondFactorActive = true;
      expect(await open.execute(seller(), { code: '000000' })).toEqual(
        err({ code: 'second-factor.invalid' }),
      );
      expect(connect.links).toEqual([]);

      build(new StaticPaymentsPolicy(null));
      identity.checks.length = 0;
      expect(await new OpenPayoutAccountLink(gate, deps).execute(seller(), { code: CODE })).toEqual(
        err({ code: 'payments.unavailable' }),
      );
      expect(identity.checks).toEqual([]);
    });

    it('shows whether the factor is on in the view, and the answer of a seller without one', async () => {
      identity.secondFactorActive = false;
      expect(await view()).toMatchObject({
        value: { status: 'not-connected', secondFactorActive: false },
      });
      await enabledAccount();
      expect(await view()).toMatchObject({
        value: { status: 'enabled', secondFactorActive: false },
      });
    });
  });

  describe('admin connected accounts', () => {
    const list = (input: { status?: unknown; cursor?: unknown } = {}, context = admin) =>
      new AdminListConnectedAccounts(gate, deps).execute(context, input);

    it('lists newest first with a cursor, by status, without any Stripe id or bank detail', async () => {
      for (let index = 0; index < 27; index += 1) {
        const sellerId = `01990000-0000-7000-8000-${String(index + 1).padStart(12, '0')}`;
        await accounts.insert(market, sellerId, T0.add({ minutes: index }));
      }
      await accounts.linkRef(market, '01990000-0000-7000-8000-000000000027', ACCOUNT);
      await accounts.applyRead(
        market,
        '01990000-0000-7000-8000-000000000027',
        snapshot(),
        'enabled',
        T0,
      );

      const first = await list();
      expect(first.ok && first.value.items).toHaveLength(25);
      expect(first.ok && first.value.items[0]).toEqual({
        sellerId: '01990000-0000-7000-8000-000000000027',
        sellerName: null,
        status: 'enabled',
        ready: true,
        requirementsDue: 0,
        requirementsPastDue: false,
        coolingOffUntil: null,
        payoutsPaused: false,
        lastReadAt: T0,
        createdAt: T0.add({ minutes: 26 }),
      });
      expect(JSON.stringify(first)).not.toContain('acct_');
      const cursor = first.ok ? first.value.nextCursor : null;
      expect(cursor).not.toBeNull();
      const second = await list({ cursor });
      expect(second.ok && second.value.items.map((i) => i.sellerId)).toEqual([
        '01990000-0000-7000-8000-000000000002',
        '01990000-0000-7000-8000-000000000001',
      ]);
      expect(second.ok && second.value.nextCursor).toBeNull();

      const enabled = await list({ status: 'enabled' });
      expect(enabled.ok && enabled.value.items).toHaveLength(1);
      expect(await list({ status: 'nope', cursor: 'x' })).toEqual(
        err({
          code: 'validation.failed',
          fields: [
            { path: 'status', code: 'value' },
            { path: 'cursor', code: 'format' },
          ],
        }),
      );
    });

    it('views one account with its changes, answers not-found, and refuses a seller or anonymous actor', async () => {
      await onboarded();
      await bankEvent('updated', 'evt_2');
      const one = new AdminViewConnectedAccount(gate, deps);

      const found = await one.execute(admin, { sellerId: SELLER });
      expect(found).toMatchObject({
        ok: true,
        value: { sellerId: SELLER, ready: false, payoutsPaused: true },
      });
      expect(found.ok && found.value.changes.map((c) => c.kind)).toEqual(['updated', 'initial']);
      expect(JSON.stringify(found)).not.toContain('acct_');
      expect(await one.execute(admin, { sellerId: OTHER_SELLER })).toEqual(
        err({ code: 'payments.connected-account.not-found' }),
      );
      expect(await one.execute(admin, { sellerId: 'x' })).toEqual(
        err({
          code: 'validation.failed',
          fields: [{ path: 'sellerId', code: 'format' }],
        }),
      );
      for (const context of [seller(), anonymous]) {
        expect((await one.execute(context, { sellerId: SELLER })).ok).toBe(false);
        expect((await list({}, context)).ok).toBe(false);
      }
    });
  });
});
