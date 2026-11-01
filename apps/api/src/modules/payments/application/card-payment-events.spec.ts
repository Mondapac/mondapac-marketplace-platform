import { err, money, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  FakeConnectGateway,
  FakeDisputeReader,
  FakeIdentityFacade,
  FakeOrderingFacade,
  FakeSessionReader,
  FakeTransferGateway,
  MemoryAccountStore,
  MemoryDisputeStore,
  MemoryInbox,
  MemoryTransferStore,
  RecordingPaymentsAudit,
  RecordingPaymentsOutbox,
  StaticPaymentsPolicy,
  stripeSignatureHeader,
  testKeyring,
  TEST_WEBHOOK_SECRET,
} from '../../../../test/support/payments-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { RecordingSecurityEvents } from '../../../../test/support/recording-security-events';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { StripeWebhookSignature } from '../infrastructure/stripe-webhook-signature';
import type { PaymentsDependencies } from './payments-dependencies';
import type { PaymentIntentSnapshot } from './ports/stripe-session-reader';
import { ApplyStripeEvents } from './use-cases/apply-stripe-events.use-case';
import { ReceiveStripeEvent } from './use-cases/receive-stripe-event.use-case';

// The PaymentIntent events of a card payment made on the MondaPac page, in memory on both Market
// fixtures (AU in AUD, ZZ in JPY): only a signed test-mode event for a PaymentIntent of this
// Market made by that flow is stored, and the worker acts only on what Stripe returns when the
// PaymentIntent is read again, never on the payload.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-14T10:00:00Z');
const ORDER = '01990000-0000-7000-8000-0000000000a1';
const TYPES = [
  'payment_intent.amount_capturable_updated',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
] as const;

describe.each([
  ['AU', 'aud', 'ZZ'],
  ['ZZ', 'jpy', 'AU'],
] as const)('card payment events in market %s', (code, currency, otherCode) => {
  const market = testMarketContext(code, 'default');
  const anonymous = testCallContext(market, 'anonymous', 'pay-0001-abcd');
  const system = testCallContext(market, 'system', 'pay-0002-abcd');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let clock: FixedClock;
  let inbox: MemoryInbox;
  let reader: FakeSessionReader;
  let ordering: FakeOrderingFacade;
  let deps: PaymentsDependencies;
  let securityEvents: RecordingSecurityEvents;
  let receive: ReceiveStripeEvent;
  let apply: ApplyStripeEvents;

  beforeEach(() => {
    securityEvents = new RecordingSecurityEvents();
    clock = new FixedClock(T0);
    inbox = new MemoryInbox();
    reader = new FakeSessionReader();
    ordering = new FakeOrderingFacade();
    deps = {
      unitOfWork: new FakeUnitOfWork(),
      inbox,
      signature: new StripeWebhookSignature({ [code]: TEST_WEBHOOK_SECRET }, clock),
      reader,
      disputeReader: new FakeDisputeReader(),
      disputes: new MemoryDisputeStore(),
      outbox: new RecordingPaymentsOutbox(),
      ordering,
      accounts: new MemoryAccountStore(),
      connect: new FakeConnectGateway(),
      transfers: new MemoryTransferStore(),
      transferGateway: new FakeTransferGateway(),
      keyring: testKeyring(),
      policy: new StaticPaymentsPolicy(),
      identity: new FakeIdentityFacade(),
      audit: new RecordingPaymentsAudit(),
      securityEvents,
      ids: new SequenceIdGenerator(clock),
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
  const intentEvent = (
    fields: {
      id?: string;
      type?: string;
      livemode?: boolean;
      account?: string;
      metadata?: Record<string, unknown>;
      object?: string;
      intentId?: string;
    } = {},
  ): Record<string, unknown> => ({
    id: fields.id ?? 'evt_pi_0001',
    object: 'event',
    type: fields.type ?? 'payment_intent.amount_capturable_updated',
    livemode: fields.livemode ?? false,
    ...(fields.account === undefined ? {} : { account: fields.account }),
    data: {
      object: {
        id: fields.intentId ?? 'pi_test_0001',
        object: fields.object ?? 'payment_intent',
        metadata: fields.metadata ?? {
          market_id: code,
          order_id: 'from-payload-not-trusted',
          payment_flow: 'card-intent',
        },
      },
    },
  });
  const intent = (fields: Partial<PaymentIntentSnapshot> = {}): PaymentIntentSnapshot => ({
    id: 'pi_test_0001',
    livemode: false,
    status: 'requires_capture',
    currency,
    amountCapturable: 3000n,
    metadataOrderId: ORDER,
    metadataMarketId: code,
    metadataPaymentFlow: 'card-intent',
    paymentMethodType: 'card',
    cardBrand: 'visa',
    ...fields,
  });
  const store = async (type: string = TYPES[0]) => {
    expect(await deliver(intentEvent({ type }))).toEqual(ok('recorded'));
  };

  describe('receive-stripe-event', () => {
    it.each(TYPES)(
      'stores a signed %s event of this Market once, as a PaymentIntent',
      async (type) => {
        const event = intentEvent({ type });

        expect(await deliver(event)).toEqual(ok('recorded'));
        expect(await deliver(event)).toEqual(ok('duplicate'));
        expect(inbox.rows.size).toBe(1);
        expect(inbox.get(code, 'evt_pi_0001')).toMatchObject({
          type,
          objectId: 'pi_test_0001',
          attempts: 0,
          processedAt: null,
        });
        expect(ordering.confirms).toEqual([]);
      },
    );

    it('acknowledges but does not store a PaymentIntent of the hosted Checkout (no card-flow tag)', async () => {
      expect(await deliver(intentEvent({ metadata: { market_id: code, order_id: 'x' } }))).toEqual(
        ok('ignored'),
      );
      expect(inbox.rows.size).toBe(0);
    });

    it("acknowledges but does not store another Market's PaymentIntent", async () => {
      const metadata = { market_id: otherCode, payment_flow: 'card-intent' };

      expect(await deliver(intentEvent({ metadata }))).toEqual(ok('other-market'));
      expect(inbox.rows.size).toBe(0);
    });

    it.each([
      ['a live-mode event', intentEvent({ livemode: true }), 'payments.event-refused'],
      ['a connected-account event', intentEvent({ account: 'acct_123' }), 'payments.event-refused'],
      [
        'an object that is not a PaymentIntent',
        intentEvent({ object: 'charge' }),
        'validation.failed',
      ],
      ['a malformed PaymentIntent id', intentEvent({ intentId: 'cs_test_1' }), 'validation.failed'],
    ])('refuses %s', async (_name, event, code2) => {
      expect(await deliver(event)).toEqual(err({ code: code2 }));
      expect(inbox.rows.size).toBe(0);
    });

    it('refuses a bad signature before reading the body', async () => {
      const body = Buffer.from(JSON.stringify(intentEvent()));

      expect(
        await receive.execute(anonymous, {
          payload: body,
          signature: stripeSignatureHeader(body, T0, 'whsec_another0secret00'),
        }),
      ).toEqual(err({ code: 'payments.signature-invalid' }));
      expect(inbox.rows.size).toBe(0);
    });
  });

  describe('apply-stripe-events', () => {
    it('confirms the order when the PaymentIntent holds the money, with no session id', async () => {
      await store();
      reader.intentAnswer = ok(intent());

      const summary = await apply.execute(system, {});

      expect(summary).toEqual(ok({ applied: 1, retried: 0, problems: [] }));
      // The order id comes from Stripe's answer, not from the payload.
      expect(reader.intentReads).toEqual(['pi_test_0001']);
      expect(ordering.confirms).toHaveLength(1);
      expect(ordering.confirms[0]!.payment).toEqual({
        orderId: ORDER,
        paymentIntentId: 'pi_test_0001',
        sessionId: null,
        amount: money(3000n, currency.toUpperCase()),
        // Read from Stripe, so a card swapped after the first token is seen by ordering.
        card: { methodType: 'card', brand: 'visa' },
      });
      expect(inbox.get(code, 'evt_pi_0001')).toMatchObject({ outcome: 'confirmed' });
    });

    it('does nothing when the PaymentIntent no longer holds the money', async () => {
      await store();
      reader.intentAnswer = ok(intent({ status: 'canceled', amountCapturable: 0n }));

      await apply.execute(system, {});

      expect(ordering.confirms).toEqual([]);
      expect(inbox.get(code, 'evt_pi_0001')).toMatchObject({ outcome: 'ignored' });
    });

    it.each(['payment_intent.payment_failed', 'payment_intent.canceled'])(
      'cancels the order on %s when the PaymentIntent holds nothing',
      async (type) => {
        await store(type);
        reader.intentAnswer = ok(
          intent({ status: 'requires_payment_method', amountCapturable: 0n }),
        );

        await apply.execute(system, {});

        expect(ordering.cancels).toEqual([{ orderId: ORDER, cause: 'payment-failed' }]);
        expect(inbox.get(code, 'evt_pi_0001')).toMatchObject({ outcome: 'cancelled' });
      },
    );

    it('never cancels an order whose PaymentIntent holds or took the money', async () => {
      await store('payment_intent.payment_failed');
      reader.intentAnswer = ok(intent({ status: 'requires_capture' }));

      await apply.execute(system, {});

      expect(ordering.cancels).toEqual([]);
      expect(inbox.get(code, 'evt_pi_0001')).toMatchObject({ outcome: 'ignored' });
    });

    it.each([
      ['a live-mode PaymentIntent', { livemode: true }],
      ["another Market's PaymentIntent", { metadataMarketId: otherCode }],
      ['one not made by the card flow', { metadataPaymentFlow: null }],
      ['one with no order id', { metadataOrderId: null }],
      ['another PaymentIntent than the event named', { id: 'pi_other_0002' }],
      ['a hold of nothing', { amountCapturable: 0n }],
    ])('rejects %s and changes no order', async (_name, fields) => {
      await store();
      reader.intentAnswer = ok(intent(fields));

      await apply.execute(system, {});

      expect(ordering.confirms).toEqual([]);
      expect(ordering.cancels).toEqual([]);
      expect(inbox.get(code, 'evt_pi_0001')).toMatchObject({ outcome: 'rejected' });
    });

    const cardCases: Array<[string, Partial<PaymentIntentSnapshot>]> = [
      ['an American Express card', { cardBrand: 'amex' }],
      [
        'a payment method that is not a card',
        { paymentMethodType: 'au_becs_debit', cardBrand: null },
      ],
      ['no payment method that could be read', { paymentMethodType: null, cardBrand: null }],
    ];
    it.each(cardCases)(
      'tells ordering what card %s is, so it can void it',
      async (_name, fields) => {
        await store();
        reader.intentAnswer = ok(intent(fields));

        await apply.execute(system, {});

        expect(ordering.confirms[0]!.payment.card).toEqual({
          methodType:
            fields.paymentMethodType === undefined ? 'card' : (fields.paymentMethodType ?? ''),
          brand: fields.cardBrand ?? null,
        });
      },
    );

    it('tries again later when Stripe cannot be read, and gives up on a refusal', async () => {
      await store();
      reader.intentAnswer = err({ code: 'payment.provider-unavailable' });
      expect(await apply.execute(system, {})).toEqual(ok({ applied: 0, retried: 1, problems: [] }));
      expect(inbox.get(code, 'evt_pi_0001')).toMatchObject({ attempts: 1, processedAt: null });

      clock.set(T0.add({ hours: 2 }));
      reader.intentAnswer = err({ code: 'payment.provider-rejected' });
      await apply.execute(system, {});
      expect(inbox.get(code, 'evt_pi_0001')).toMatchObject({ outcome: 'rejected' });
    });

    it('tries again later when ordering asks for it', async () => {
      await store();
      reader.intentAnswer = ok(intent());
      ordering.confirmAnswer = err({ code: 'ordering.try-again' });

      expect(await apply.execute(system, {})).toEqual(ok({ applied: 0, retried: 1, problems: [] }));
    });
  });
});
