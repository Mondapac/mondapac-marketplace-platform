import { err, ok, Temporal } from '@mondapac/shared-kernel';
import { FixedClock, testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import {
  checkoutEvent,
  FakeOrderingFacade,
  FakeSessionReader,
  MemoryInbox,
  stripeSignatureHeader,
  TEST_WEBHOOK_SECRET,
} from '../../../../test/support/payments-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { StripeWebhookSignature } from '../infrastructure/stripe-webhook-signature';
import { APPLY_BATCH, MAX_ATTEMPTS, retryDelaySeconds } from './apply-flow';
import type { PaymentsDependencies } from './payments-dependencies';
import type { CheckoutSessionSnapshot } from './ports/stripe-session-reader';
import { ApplyStripeEvents } from './use-cases/apply-stripe-events.use-case';
import { ReceiveStripeEvent } from './use-cases/receive-stripe-event.use-case';

// The Stripe webhook receiver in memory on both Market fixtures (AU in AUD, ZZ in JPY): the
// signature on the exact bytes first, test mode and platform account only, one row per event id,
// and the worker acting only on what Stripe returns when the session is read again.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const ORDER = '01990000-0000-7000-8000-0000000000a1';

describe.each([
  ['AU', 'aud', 'ZZ'],
  ['ZZ', 'jpy', 'AU'],
] as const)('payments use cases in market %s', (code, currency, otherCode) => {
  const market = testMarketContext(code, 'default');
  const anonymous = testCallContext(market, 'anonymous', 'pay-0001-abcd');
  const system = testCallContext(market, 'system', 'pay-0002-abcd');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let clock: FixedClock;
  let inbox: MemoryInbox;
  let reader: FakeSessionReader;
  let ordering: FakeOrderingFacade;
  let deps: PaymentsDependencies;
  let receive: ReceiveStripeEvent;
  let apply: ApplyStripeEvents;

  const session = (fields: Partial<CheckoutSessionSnapshot> = {}): CheckoutSessionSnapshot => ({
    id: 'cs_test_0001',
    livemode: false,
    status: 'complete',
    paymentStatus: 'unpaid',
    clientReferenceId: ORDER,
    metadataOrderId: ORDER,
    metadataMarketId: code,
    paymentIntent: {
      id: 'pi_test_0001',
      status: 'requires_capture',
      currency,
      amountCapturable: 3000n,
      amountReceived: 0n,
    },
    ...fields,
  });

  beforeEach(() => {
    clock = new FixedClock(T0);
    inbox = new MemoryInbox();
    reader = new FakeSessionReader();
    ordering = new FakeOrderingFacade();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      inbox,
      signature: new StripeWebhookSignature({ [code]: TEST_WEBHOOK_SECRET }, clock),
      reader,
      ordering,
      clock,
    };
    receive = new ReceiveStripeEvent(gate, deps);
    apply = new ApplyStripeEvents(gate, deps);
  });

  const signed = (event: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(event));
    return { payload: body, signature: stripeSignatureHeader(body, T0) };
  };
  const deliver = (event: Record<string, unknown>) => receive.execute(anonymous, signed(event));

  describe('receive-stripe-event', () => {
    it('stores a signed Checkout event of this Market once, and a repeat is a duplicate', async () => {
      const event = checkoutEvent({ marketId: code });

      expect(await deliver(event)).toEqual(ok('recorded'));
      expect(await deliver(event)).toEqual(ok('duplicate'));
      expect(inbox.rows.size).toBe(1);
      expect(inbox.get(code, 'evt_test_0001')).toMatchObject({
        type: 'checkout.session.completed',
        objectId: 'cs_test_0001',
        attempts: 0,
        processedAt: null,
      });
      expect(ordering.confirms).toEqual([]);
    });

    it('acknowledges a type it does not act on without storing it', async () => {
      const event = checkoutEvent({ type: 'payment_intent.payment_failed', marketId: code });

      expect(await deliver(event)).toEqual(ok('ignored'));
      expect(inbox.rows.size).toBe(0);
    });

    it('refuses a bad signature before reading the body', async () => {
      const event = checkoutEvent({ marketId: code });
      const body = Buffer.from(JSON.stringify(event));
      const cases = [
        stripeSignatureHeader(body, T0, 'whsec_another0secret00'),
        stripeSignatureHeader(Buffer.from(`${JSON.stringify(event)} `), T0),
        stripeSignatureHeader(body, T0.subtract({ seconds: 301 })),
        stripeSignatureHeader(body, T0.add({ seconds: 301 })),
        undefined,
        ['t=1', 'v1=00'],
        't=,v1=',
      ];
      for (const signature of cases) {
        expect(await receive.execute(anonymous, { payload: body, signature })).toEqual(
          err({ code: 'payments.signature-invalid' }),
        );
      }
      // Within the tolerance, one matching v1 among others passes.
      const good = stripeSignatureHeader(body, T0.subtract({ seconds: 299 }));
      const header = `${good},v1=${'0'.repeat(64)}`;
      expect(await receive.execute(anonymous, { payload: body, signature: header })).toEqual(
        ok('recorded'),
      );
    });

    it("answers unavailable when this Market has no signing secret, and never uses another Market's", async () => {
      deps = {
        ...deps,
        signature: new StripeWebhookSignature({ [otherCode]: TEST_WEBHOOK_SECRET }, clock),
      };
      receive = new ReceiveStripeEvent(gate, deps);

      expect(await deliver(checkoutEvent({ marketId: code }))).toEqual(
        err({ code: 'payments.webhook-unavailable' }),
      );
    });

    it('refuses live-mode and connected-account events', async () => {
      for (const event of [
        checkoutEvent({ marketId: code, livemode: true }),
        checkoutEvent({ marketId: code, account: 'acct_123' }),
        checkoutEvent({ marketId: code, type: 'payment_intent.succeeded', livemode: true }),
      ]) {
        expect(await deliver(event)).toEqual(err({ code: 'payments.event-refused' }));
      }
      expect(inbox.rows.size).toBe(0);
    });

    it("acknowledges another Market's event, or one without a Market, and never stores it", async () => {
      expect(await deliver(checkoutEvent({ marketId: otherCode }))).toEqual(ok('other-market'));
      const unmarked = checkoutEvent({ marketId: code });
      (unmarked.data as { object: { metadata: object } }).object.metadata = {};
      expect(await deliver(unmarked)).toEqual(ok('other-market'));
      expect(inbox.rows.size).toBe(0);
    });

    it('refuses a signed body that is not a well-formed event', async () => {
      const malformed = [
        { ...checkoutEvent({ marketId: code }), id: 'not-an-event-id' },
        { ...checkoutEvent({ marketId: code }), livemode: 'false' },
        { ...checkoutEvent({ marketId: code }), data: { object: { object: 'payment_intent' } } },
        {
          ...checkoutEvent({ marketId: code }),
          data: { object: { id: 'pi_1', object: 'checkout.session' } },
        },
      ];
      for (const event of malformed) {
        expect(await deliver(event)).toEqual(err({ code: 'validation.failed' }));
      }
      for (const raw of ['[]', 'not json', 'ÿ']) {
        const body = Buffer.from(raw, raw === 'ÿ' ? 'latin1' : 'utf8');
        expect(
          await receive.execute(anonymous, {
            payload: body,
            signature: stripeSignatureHeader(body, T0),
          }),
        ).toEqual(err({ code: 'validation.failed' }));
      }
    });
  });

  describe('apply-stripe-events', () => {
    const store = async (type: string, id = 'evt_test_0001') => {
      expect(await deliver(checkoutEvent({ id, type, marketId: code }))).toEqual(ok('recorded'));
    };

    it('confirms a held payment with what Stripe returns, as the system actor, once', async () => {
      await store('checkout.session.completed');
      reader.answer = ok(session());

      const result = await apply.execute(system, {});

      expect(result).toEqual(ok({ applied: 1, retried: 0, problems: [] }));
      expect(reader.reads).toEqual(['cs_test_0001']);
      expect(ordering.confirms).toHaveLength(1);
      expect(ordering.confirms[0]?.context).toBe(system);
      expect(ordering.confirms[0]?.payment).toEqual({
        orderId: ORDER,
        paymentIntentId: 'pi_test_0001',
        sessionId: 'cs_test_0001',
        amount: { amount: 3000n, currency: currency.toUpperCase() },
      });
      expect(inbox.get(code, 'evt_test_0001')).toMatchObject({
        outcome: 'confirmed',
        processedAt: T0,
      });
      // Done events are not taken again.
      expect(await apply.execute(system, {})).toEqual(ok({ applied: 0, retried: 0, problems: [] }));
      expect(ordering.confirms).toHaveLength(1);
    });

    it('passes the received amount of a payment captured by an earlier, unfinished confirm', async () => {
      await store('checkout.session.completed');
      ordering.confirmAnswer = ok('already-confirmed');
      reader.answer = ok(
        session({
          paymentIntent: {
            id: 'pi_test_0001',
            status: 'succeeded',
            currency,
            amountCapturable: 0n,
            amountReceived: 3000n,
          },
        }),
      );

      await apply.execute(system, {});

      expect(ordering.confirms[0]?.payment.amount).toEqual({
        amount: 3000n,
        currency: currency.toUpperCase(),
      });
      expect(inbox.get(code, 'evt_test_0001')?.outcome).toBe('already-confirmed');
    });

    it('ignores a completed session whose payment is no longer held', async () => {
      await store('checkout.session.completed');
      reader.answer = ok(
        session({
          paymentIntent: {
            id: 'pi_test_0001',
            status: 'canceled',
            currency,
            amountCapturable: 0n,
            amountReceived: 0n,
          },
        }),
      );

      await apply.execute(system, {});

      expect(ordering.confirms).toEqual([]);
      expect(inbox.get(code, 'evt_test_0001')?.outcome).toBe('ignored');
    });

    it('cancels the order of an expired session, and of an async payment failure', async () => {
      await store('checkout.session.expired', 'evt_test_0001');
      reader.answer = ok(session({ status: 'expired', paymentIntent: null }));
      await apply.execute(system, {});
      await store('checkout.session.async_payment_failed', 'evt_test_0002');
      reader.answer = ok(
        session({
          paymentIntent: {
            id: 'pi_test_0001',
            status: 'requires_payment_method',
            currency,
            amountCapturable: 0n,
            amountReceived: 0n,
          },
        }),
      );
      await apply.execute(system, {});

      expect(ordering.cancels).toEqual([
        { orderId: ORDER, cause: 'expired' },
        { orderId: ORDER, cause: 'payment-failed' },
      ]);
      expect(ordering.confirms).toEqual([]);
      expect(inbox.get(code, 'evt_test_0001')?.outcome).toBe('cancelled');
      expect(inbox.get(code, 'evt_test_0002')?.outcome).toBe('cancelled');
    });

    it('never acts when the session read again does not fit the event, this Market or the order', async () => {
      const misfits: Partial<CheckoutSessionSnapshot>[] = [
        { livemode: true },
        { metadataMarketId: otherCode },
        { clientReferenceId: '01990000-0000-7000-8000-0000000000a2' },
        { metadataOrderId: null },
        { id: 'cs_test_other' },
        { status: 'open' },
        { paymentIntent: null },
      ];
      for (const [index, misfit] of misfits.entries()) {
        const eventId = `evt_test_${index}`;
        await store('checkout.session.completed', eventId);
        reader.answer = ok(session(misfit));
        const result = await apply.execute(system, {});
        expect(result).toEqual(
          ok({ applied: 1, retried: 0, problems: [{ eventId, outcome: 'rejected' }] }),
        );
      }
      // An expired event for a session that is not expired, a failure for a paid one.
      await store('checkout.session.expired', 'evt_test_x1');
      reader.answer = ok(session({ status: 'complete' }));
      await apply.execute(system, {});
      await store('checkout.session.async_payment_failed', 'evt_test_x2');
      reader.answer = ok(session({ paymentStatus: 'paid', paymentIntent: null }));
      await apply.execute(system, {});
      // A failure event for a session whose card is still held: the hold is never voided.
      await store('checkout.session.async_payment_failed', 'evt_test_x3');
      reader.answer = ok(session());
      await apply.execute(system, {});
      await store('checkout.session.async_payment_failed', 'evt_test_x4');
      reader.answer = ok(session({ status: 'open', paymentIntent: null }));
      await apply.execute(system, {});

      expect(ordering.confirms).toEqual([]);
      expect(ordering.cancels).toEqual([]);
      expect(inbox.get(code, 'evt_test_x1')?.outcome).toBe('rejected');
      expect(inbox.get(code, 'evt_test_x2')?.outcome).toBe('rejected');
      expect(inbox.get(code, 'evt_test_x3')?.outcome).toBe('rejected');
      expect(inbox.get(code, 'evt_test_x4')?.outcome).toBe('rejected');
    });

    it('tries again later with a growing delay, then marks the event failed', async () => {
      await store('checkout.session.completed');
      reader.answer = err({ code: 'payment.provider-unavailable' });

      expect(await apply.execute(system, {})).toEqual(ok({ applied: 0, retried: 1, problems: [] }));
      expect(inbox.get(code, 'evt_test_0001')).toMatchObject({
        attempts: 1,
        nextAttemptAt: T0.add({ seconds: 10 }),
      });
      // Not due yet: nothing is read.
      expect(await apply.execute(system, {})).toEqual(ok({ applied: 0, retried: 0, problems: [] }));
      expect(reader.reads).toHaveLength(1);

      // ordering's temporary fault is a retry too.
      reader.answer = ok(session());
      ordering.confirmAnswer = err({ code: 'ordering.try-again' });
      for (let attempt = 2; attempt < MAX_ATTEMPTS; attempt += 1) {
        clock.set(inbox.get(code, 'evt_test_0001')!.nextAttemptAt);
        expect(await apply.execute(system, {})).toEqual(
          ok({ applied: 0, retried: 1, problems: [] }),
        );
        expect(inbox.get(code, 'evt_test_0001')?.attempts).toBe(attempt);
      }
      clock.set(inbox.get(code, 'evt_test_0001')!.nextAttemptAt);
      expect(await apply.execute(system, {})).toEqual(
        ok({ applied: 1, retried: 0, problems: [{ eventId: 'evt_test_0001', outcome: 'failed' }] }),
      );
      expect(inbox.get(code, 'evt_test_0001')?.outcome).toBe('failed');
      expect([1, 2, 3, 9, 12].map(retryDelaySeconds)).toEqual([10, 20, 40, 2560, 3600]);
    });

    it('marks an order ordering does not know as rejected, and a session Stripe refuses too', async () => {
      await store('checkout.session.completed', 'evt_test_0001');
      reader.answer = ok(session());
      ordering.confirmAnswer = err({ code: 'ordering.order-not-found' });
      await apply.execute(system, {});
      await store('checkout.session.completed', 'evt_test_0002');
      reader.answer = err({ code: 'payment.provider-rejected' });
      await apply.execute(system, {});

      expect(inbox.get(code, 'evt_test_0001')?.outcome).toBe('rejected');
      expect(inbox.get(code, 'evt_test_0002')?.outcome).toBe('rejected');
    });

    it('marks an event failed when ordering refuses the system actor', async () => {
      await store('checkout.session.completed');
      reader.answer = ok(session());
      ordering.confirmAnswer = err({ code: 'access.denied' });

      expect(await apply.execute(system, {})).toEqual(
        ok({ applied: 1, retried: 0, problems: [{ eventId: 'evt_test_0001', outcome: 'failed' }] }),
      );
    });

    it('never applies an event again when Stripe delivers it after it was applied', async () => {
      await store('checkout.session.completed');
      reader.answer = ok(session());
      await apply.execute(system, {});

      expect(await deliver(checkoutEvent({ marketId: code }))).toEqual(ok('duplicate'));
      expect(await apply.execute(system, {})).toEqual(ok({ applied: 0, retried: 0, problems: [] }));
      expect(ordering.confirms).toHaveLength(1);
    });

    it('takes at most one batch per run, oldest first', async () => {
      for (let n = 0; n < APPLY_BATCH + 2; n += 1) {
        await store('checkout.session.expired', `evt_test_${n.toString().padStart(3, '0')}`);
      }
      reader.answer = ok(session({ status: 'expired' }));

      expect(await apply.execute(system, {})).toEqual(
        ok({ applied: APPLY_BATCH, retried: 0, problems: [] }),
      );
      expect(await apply.execute(system, {})).toEqual(ok({ applied: 2, retried: 0, problems: [] }));
    });

    it('is refused to anyone but the system actor', async () => {
      const result = await apply.execute(anonymous, {});

      expect(result.ok).toBe(false);
      expect(reader.reads).toEqual([]);
    });
  });
});
