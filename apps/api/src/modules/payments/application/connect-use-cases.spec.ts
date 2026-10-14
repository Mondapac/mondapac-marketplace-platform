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
  FakeSessionReader,
  MemoryAccountStore,
  MemoryInbox,
  RecordingPaymentsAudit,
  StaticPaymentsPolicy,
  stripeSignatureHeader,
  TEST_CONNECT_WEBHOOK_SECRET,
  TEST_WEBHOOK_SECRET,
} from '../../../../test/support/payments-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { StripeWebhookSignature } from '../infrastructure/stripe-webhook-signature';
import type { PaymentsDependencies } from './payments-dependencies';
import type { AccountSnapshot } from '../domain/connected-account';
import { ApplyStripeEvents } from './use-cases/apply-stripe-events.use-case';
import { ConnectPayoutAccount } from './use-cases/connect-payout-account.use-case';
import { OpenPayoutAccountLink } from './use-cases/open-payout-account-link.use-case';
import { PayoutReadinessQuery } from './use-cases/payout-readiness.use-case';
import { ReceiveStripeEvent } from './use-cases/receive-stripe-event.use-case';
import { ViewPayoutAccount } from './use-cases/view-payout-account.use-case';

// The seller payout account (Stripe Connect Express) in memory on both Market fixtures: one
// Stripe account per seller created with a stored key, the hosted page, the state kept from
// Connect events that are read again from Stripe, and the readiness answer for payouts.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const SELLER = '01990000-0000-7000-8000-0000000000b1';
const OTHER_SELLER = '01990000-0000-7000-8000-0000000000b2';
const ACCOUNT = 'acct_test_0001';
const CODE = '123456';

describe.each(['AU', 'ZZ'] as const)('payout account in market %s', (code) => {
  const otherCode = code === 'AU' ? 'ZZ' : 'AU';
  const market = testMarketContext(code, 'default');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });
  const seller = (sellerId: string): CallContext =>
    testCallContext(
      market,
      testAuthenticatedActor(market, {
        population: 'seller',
        accountId: '01990000-0000-7000-8000-0000000000c1' as Id<'Account'>,
        sessionId: '01990000-0000-7000-8000-0000000000d1' as Id<'Session'>,
        sellerId: sellerId as Id<'Seller'>,
      }),
    );
  const customer = testCallContext(
    market,
    testAuthenticatedActor(market, {
      population: 'customer',
      accountId: '01990000-0000-7000-8000-0000000000c2' as Id<'Account'>,
      sessionId: '01990000-0000-7000-8000-0000000000d2' as Id<'Session'>,
      sellerId: null,
    }),
  );
  const anonymous = testCallContext(market, 'anonymous', 'pay-0001-abcd');
  const system = testCallContext(market, 'system', 'pay-0002-abcd');

  let clock: FixedClock;
  let accounts: MemoryAccountStore;
  let connect: FakeConnectGateway;
  let inbox: MemoryInbox;
  let deps: PaymentsDependencies;
  const build = (policy = new StaticPaymentsPolicy(code === 'AU' ? 'AU' : 'JP')) => {
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      inbox,
      signature: new StripeWebhookSignature({ [code]: TEST_WEBHOOK_SECRET }, clock, {
        [code]: TEST_CONNECT_WEBHOOK_SECRET,
      }),
      reader: new FakeSessionReader(),
      ordering: new FakeOrderingFacade(),
      accounts,
      connect,
      policy,
      identity: new FakeIdentityFacade(),
      audit: new RecordingPaymentsAudit(),
      ids: new SequenceIdGenerator(clock),
      clock,
    };
  };

  beforeEach(() => {
    clock = new FixedClock(T0);
    accounts = new MemoryAccountStore();
    connect = new FakeConnectGateway();
    inbox = new MemoryInbox();
    build();
  });

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
    ...fields,
  });

  describe('connect-payout-account and open-payout-account-link', () => {
    it('stores the seller first, creates the Stripe account once with the stored key and answers the page', async () => {
      const result = await new ConnectPayoutAccount(gate, deps).execute(seller(SELLER), {
        code: CODE,
      });

      expect(result).toEqual(
        ok({
          status: 'not-started',
          ready: false,
          requirementsDue: 0,
          requirementsPastDue: false,
          secondFactorActive: true,
          coolingOffUntil: null,
          payoutsPaused: false,
          changes: [],
          url: 'https://connect.stripe.test/setup/s/abc',
        }),
      );
      expect(connect.creates).toEqual([
        {
          idempotencyKey: `connected-account:${code}:${SELLER}`,
          country: code === 'AU' ? 'AU' : 'JP',
          marketId: code,
          sellerId: SELLER,
        },
      ]);
      expect(connect.links).toEqual([
        {
          accountRef: ACCOUNT,
          kind: 'onboarding',
          returnUrl: 'https://seller.test/payout-account?stripe=return',
          refreshUrl: 'https://seller.test/payout-account?stripe=refresh',
        },
      ]);
      expect(accounts.rows.get(`${code}/${SELLER}`)).toMatchObject({ accountRef: ACCOUNT });

      await new ConnectPayoutAccount(gate, deps).execute(seller(SELLER), { code: CODE });
      expect(connect.creates).toHaveLength(1);
      expect(connect.links).toHaveLength(2);
    });

    it('keeps the row when Stripe fails and repeats the same key the next time', async () => {
      connect.createAnswer = err({ code: 'payment.provider-unavailable' });
      const connectCase = new ConnectPayoutAccount(gate, deps);
      expect(await connectCase.execute(seller(SELLER), { code: CODE })).toEqual(
        err({ code: 'payments.unavailable' }),
      );
      expect(accounts.rows.get(`${code}/${SELLER}`)).toMatchObject({ accountRef: null });

      connect.createAnswer = ok({ accountRef: ACCOUNT });
      expect((await connectCase.execute(seller(SELLER), { code: CODE })).ok).toBe(true);
      expect(connect.creates.map((c) => c.idempotencyKey)).toEqual([
        `connected-account:${code}:${SELLER}`,
        `connected-account:${code}:${SELLER}`,
      ]);
    });

    it('creates once when two requests race, and refuses a repeat after the key may have expired', async () => {
      const connectCase = new ConnectPayoutAccount(gate, deps);
      const both = await Promise.all([
        connectCase.execute(seller(SELLER), { code: CODE }),
        connectCase.execute(seller(SELLER), { code: CODE }),
      ]);
      expect(both.every((r) => r.ok)).toBe(true);
      expect(accounts.rows.get(`${code}/${SELLER}`)?.accountRef).toBe(ACCOUNT);

      // A row that never got its Stripe id and is a day old is not created again.
      await accounts.insert(market, OTHER_SELLER, T0.subtract({ hours: 24 }));
      const before = connect.creates.length;
      expect(await connectCase.execute(seller(OTHER_SELLER), { code: CODE })).toEqual(
        err({ code: 'payments.unavailable' }),
      );
      expect(connect.creates).toHaveLength(before);
    });

    it('answers unavailable without a country or return pages, and when the page cannot be made', async () => {
      build(new StaticPaymentsPolicy(null));
      expect(
        await new ConnectPayoutAccount(gate, deps).execute(seller(SELLER), { code: CODE }),
      ).toEqual(err({ code: 'payments.unavailable' }));
      build(new StaticPaymentsPolicy('AU', null));
      expect(
        await new ConnectPayoutAccount(gate, deps).execute(seller(SELLER), { code: CODE }),
      ).toEqual(err({ code: 'payments.unavailable' }));
      expect(connect.creates).toEqual([]);

      build();
      connect.linkAnswer = err({ code: 'payment.provider-rejected' });
      expect(
        await new ConnectPayoutAccount(gate, deps).execute(seller(SELLER), { code: CODE }),
      ).toEqual(err({ code: 'payments.unavailable' }));
    });

    it('opens a page only for an existing account, and none when rejected', async () => {
      const open = new OpenPayoutAccountLink(gate, deps);
      expect(await open.execute(seller(SELLER), { code: CODE })).toEqual(
        err({ code: 'payments.payout-account.not-found' }),
      );
      expect(accounts.rows.size).toBe(0);

      await new ConnectPayoutAccount(gate, deps).execute(seller(SELLER), { code: CODE });
      await accounts.applyRead(market, SELLER, snapshot(), 'enabled', T0);
      expect((await open.execute(seller(SELLER), { code: CODE })).ok).toBe(true);
      expect(connect.links.at(-1)?.kind).toBe('onboarding');

      await accounts.applyRead(market, SELLER, snapshot(), 'rejected', T0.add({ seconds: 1 }));
      expect(await open.execute(seller(SELLER), { code: CODE })).toEqual(
        err({ code: 'payments.payout-account.rejected' }),
      );
    });

    it('uses only the session seller and refuses every other actor', async () => {
      for (const context of [customer, anonymous]) {
        expect(
          (await new ConnectPayoutAccount(gate, deps).execute(context, { code: CODE })).ok,
        ).toBe(false);
        expect((await new ViewPayoutAccount(gate, deps).execute(context, {})).ok).toBe(false);
      }
      expect(connect.creates).toEqual([]);
      expect(accounts.rows.size).toBe(0);
    });
  });

  describe('view-payout-account', () => {
    it("shows not-connected, then the stored state, and never another seller's", async () => {
      const view = new ViewPayoutAccount(gate, deps);
      expect(await view.execute(seller(SELLER), {})).toEqual(
        ok({
          status: 'not-connected',
          ready: false,
          requirementsDue: 0,
          requirementsPastDue: false,
          secondFactorActive: true,
          coolingOffUntil: null,
          payoutsPaused: false,
          changes: [],
        }),
      );
      await new ConnectPayoutAccount(gate, deps).execute(seller(SELLER), { code: CODE });
      await accounts.applyRead(
        market,
        SELLER,
        snapshot({ requirementsDue: 2, requirementsPastDue: true }),
        'restricted',
        T0,
      );
      expect(await view.execute(seller(SELLER), {})).toEqual(
        ok({
          status: 'restricted',
          ready: false,
          requirementsDue: 2,
          requirementsPastDue: true,
          secondFactorActive: true,
          coolingOffUntil: null,
          payoutsPaused: false,
          changes: [],
        }),
      );
      expect(await view.execute(seller(OTHER_SELLER), {})).toEqual(
        ok({
          status: 'not-connected',
          ready: false,
          requirementsDue: 0,
          requirementsPastDue: false,
          secondFactorActive: true,
          coolingOffUntil: null,
          payoutsPaused: false,
          changes: [],
        }),
      );
      expect(connect.reads).toEqual([]);
    });
  });

  describe('payout-readiness', () => {
    it('is ready only for an enabled account, false for unknown sellers, and refuses bad input', async () => {
      const readiness = new PayoutReadinessQuery(gate, deps);
      await new ConnectPayoutAccount(gate, deps).execute(seller(SELLER), { code: CODE });
      await accounts.applyRead(market, SELLER, snapshot(), 'enabled', T0);
      await new ConnectPayoutAccount(gate, deps).execute(seller(OTHER_SELLER), { code: CODE });

      expect(await readiness.execute(system, [SELLER, OTHER_SELLER, 'x'.padEnd(36, '0')])).toEqual(
        err({ code: 'validation.failed' }),
      );
      expect(
        await readiness.execute(system, [
          SELLER,
          OTHER_SELLER,
          '01990000-0000-7000-8000-0000000000b3',
        ]),
      ).toEqual(
        ok([
          { sellerId: SELLER, ready: true },
          { sellerId: OTHER_SELLER, ready: false },
          { sellerId: '01990000-0000-7000-8000-0000000000b3', ready: false },
        ]),
      );
      const many = Array.from({ length: 101 }, () => SELLER);
      expect(await readiness.execute(system, many)).toEqual(err({ code: 'validation.failed' }));
      expect((await readiness.execute(seller(SELLER), [SELLER])).ok).toBe(false);
    });
  });

  describe('Connect events', () => {
    const signed = (event: Record<string, unknown>, secret = TEST_CONNECT_WEBHOOK_SECRET) => {
      const body = Buffer.from(JSON.stringify(event));
      return { payload: body, signature: stripeSignatureHeader(body, T0, secret) };
    };
    const receive = (event: Record<string, unknown>, secret?: string) =>
      new ReceiveStripeEvent(gate, deps).execute(anonymous, signed(event, secret));

    it('stores an account event signed with the Connect secret, once, by the account id', async () => {
      const event = accountEvent({ marketId: code });
      expect(await receive(event)).toEqual(ok('recorded'));
      expect(await receive(event)).toEqual(ok('duplicate'));
      expect(inbox.get(code, 'evt_test_acct_0001')).toMatchObject({
        type: 'account.updated',
        objectId: ACCOUNT,
      });
      expect(
        await receive(accountEvent({ id: 'evt_test_cap_0001', type: 'capability.updated' })),
      ).toEqual(ok('recorded'));
      expect(inbox.get(code, 'evt_test_cap_0001')).toMatchObject({ objectId: ACCOUNT });
    });

    it('refuses an event of the wrong endpoint kind, live mode, or no account, and drops another Market', async () => {
      const refused = err({ code: 'payments.event-refused' });
      expect(await receive(accountEvent({ marketId: code }), TEST_WEBHOOK_SECRET)).toEqual(refused);
      expect(await receive(accountEvent({ marketId: code, account: null }))).toEqual(refused);
      expect(await receive(accountEvent({ marketId: code, account: 'not-an-account' }))).toEqual(
        refused,
      );
      expect(await receive(accountEvent({ marketId: code, livemode: true }))).toEqual(refused);
      expect(await receive(accountEvent({ marketId: otherCode }))).toEqual(ok('other-market'));
      expect(
        await receive({ ...accountEvent({ marketId: code }), type: 'account.deleted' }),
      ).toEqual(ok('ignored'));
      expect(inbox.rows.size).toBe(0);
    });

    describe('applying', () => {
      const apply = () => new ApplyStripeEvents(gate, deps).execute(system, {});
      const store = async () => {
        await receive(accountEvent({ marketId: code }));
        await new ConnectPayoutAccount(gate, deps).execute(seller(SELLER), { code: CODE });
      };

      it('reads the account again and stores what Stripe returns', async () => {
        await store();
        connect.readAnswer = ok(snapshot());
        const result = await apply();
        expect(result).toEqual(ok({ applied: 1, retried: 0, problems: [] }));
        expect(connect.reads).toEqual([ACCOUNT]);
        expect(accounts.rows.get(`${code}/${SELLER}`)).toMatchObject({
          status: 'enabled',
          transfersActive: true,
          payoutsEnabled: true,
        });
        expect(inbox.get(code, 'evt_test_acct_0001')?.outcome).toBe('account-updated');
      });

      it('rejects an account of another Market or an unknown account, and retries a Stripe fault', async () => {
        await store();
        connect.readAnswer = ok(snapshot({ metadataMarketId: otherCode }));
        await apply();
        expect(inbox.get(code, 'evt_test_acct_0001')?.outcome).toBe('rejected');
        expect(accounts.rows.get(`${code}/${SELLER}`)?.status).toBe('not-started');

        await receive(accountEvent({ id: 'evt_test_acct_0002', marketId: code }));
        connect.readAnswer = ok(snapshot({ metadataSellerId: OTHER_SELLER }));
        await apply();
        expect(inbox.get(code, 'evt_test_acct_0002')?.outcome).toBe('rejected');

        await receive(accountEvent({ id: 'evt_test_acct_0003', marketId: code }));
        connect.readAnswer = err({ code: 'payment.provider-unavailable' });
        expect(await apply()).toEqual(ok({ applied: 0, retried: 1, problems: [] }));
        expect(inbox.get(code, 'evt_test_acct_0003')?.processedAt).toBeNull();
      });

      it('links the Stripe id of a seller whose create answer was lost', async () => {
        await receive(accountEvent({ marketId: code }));
        await accounts.insert(market, SELLER);
        connect.readAnswer = ok(snapshot());
        await apply();
        expect(accounts.rows.get(`${code}/${SELLER}`)).toMatchObject({
          accountRef: ACCOUNT,
          status: 'enabled',
        });
      });
    });
  });
});
