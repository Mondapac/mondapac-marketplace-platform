import { err, money, ok, Temporal } from '@mondapac/shared-kernel';
import {
  FixedClock,
  SequenceIdGenerator,
  testCallContext,
  testMarketContext,
} from '@mondapac/shared-kernel/testing';
import {
  disputeEvent,
  FakeConnectGateway,
  FakeDisputeReader,
  FakeIdentityFacade,
  FakeOrderingFacade,
  FakeTransferGateway,
  FakeSessionReader,
  MemoryAccountStore,
  MemoryDisputeStore,
  MemoryInbox,
  MemoryTransferStore,
  RecordingPaymentsAudit,
  RecordingPaymentsOutbox,
  StaticPaymentsPolicy,
  testKeyring,
  stripeSignatureHeader,
  TEST_WEBHOOK_SECRET,
} from '../../../../test/support/payments-fakes';
import { FakeUnitOfWork } from '../../../../test/support/pricing-fakes';
import { RecordingSecurityEvents } from '../../../../test/support/recording-security-events';
import { TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS } from '../../../../test/support/test-config';
import { createUseCaseGate } from '../../../platform/authz/use-case-gate';
import { loadMarketConfigs } from '../../../platform/market-config/market-config';
import { MarketRegistry } from '../../../platform/market-config/market-registry';
import { StripeWebhookSignature } from '../infrastructure/stripe-webhook-signature';
import { MAX_DISPUTE_IDS } from './dispute-flow';
import type { PaymentsDependencies } from './payments-dependencies';
import type { DisputeSnapshot } from './ports/stripe-dispute-reader';
import { ApplyStripeEvents } from './use-cases/apply-stripe-events.use-case';
import { DisputeOfQuery } from './use-cases/dispute-of.use-case';
import { ReceiveStripeEvent } from './use-cases/receive-stripe-event.use-case';

// Dispute intake (package 8a) in memory on both Market fixtures (AU in AUD, ZZ in JPY): the
// receiver keeps the five dispute types, the worker records only what Stripe returns when the
// dispute is read again, one `payments.dispute-changed.v1` per stored change, money flags that
// never go back, and `disputeOf` answering from the stored state.

const markets = new MarketRegistry(loadMarketConfigs(TEST_MARKET_CONFIG_DIRS, TEST_MARKET_IDS));
const T0 = Temporal.Instant.from('2026-10-27T10:00:00Z');
const OPENED = Temporal.Instant.from('2026-10-26T08:00:00Z');
const DUE = Temporal.Instant.from('2026-11-05T23:59:59Z');
const ORDER = '01990000-0000-7000-8000-0000000000a1';

describe.each([
  ['AU', 'aud', 'ZZ'],
  ['ZZ', 'jpy', 'AU'],
] as const)('dispute intake in market %s', (code, currency, otherCode) => {
  const market = testMarketContext(code, 'default');
  const anonymous = testCallContext(market, 'anonymous', 'dsp-0001-abcd');
  const system = testCallContext(market, 'system', 'dsp-0002-abcd');
  const gate = createUseCaseGate(markets, { check: () => Promise.resolve({ allowed: true }) });

  let clock: FixedClock;
  let inbox: MemoryInbox;
  let reader: FakeDisputeReader;
  let disputes: MemoryDisputeStore;
  let outbox: RecordingPaymentsOutbox;
  let ordering: FakeOrderingFacade;
  let securityEvents: RecordingSecurityEvents;
  let receive: ReceiveStripeEvent;
  let apply: ApplyStripeEvents;
  let disputeOf: DisputeOfQuery;

  const snapshot = (fields: Partial<DisputeSnapshot> = {}): DisputeSnapshot => ({
    id: 'dp_test_0001',
    livemode: false,
    status: 'needs_response',
    reason: 'fraudulent',
    amount: 3000n,
    currency,
    openedAt: OPENED,
    evidenceDueBy: DUE,
    fundsWithdrawn: false,
    fundsReinstated: false,
    paymentIntent: { id: 'pi_test_0001', metadataOrderId: ORDER, metadataMarketId: code },
    ...fields,
  });

  beforeEach(() => {
    clock = new FixedClock(T0);
    inbox = new MemoryInbox();
    reader = new FakeDisputeReader();
    disputes = new MemoryDisputeStore();
    outbox = new RecordingPaymentsOutbox();
    ordering = new FakeOrderingFacade();
    securityEvents = new RecordingSecurityEvents();
    const deps: PaymentsDependencies = {
      unitOfWork: new FakeUnitOfWork(),
      inbox,
      signature: new StripeWebhookSignature({ [code]: TEST_WEBHOOK_SECRET }, clock),
      reader: new FakeSessionReader(),
      disputeReader: reader,
      disputes,
      outbox,
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
    disputeOf = new DisputeOfQuery(gate, deps);
  });

  const deliver = (event: Record<string, unknown>) => {
    const body = Buffer.from(JSON.stringify(event));
    return receive.execute(anonymous, {
      payload: body,
      signature: stripeSignatureHeader(body, clock.now()),
    });
  };
  /** Delivers one dispute event and runs the worker once; the event's outcome. */
  const applyEvent = async (eventId: string, type = 'charge.dispute.created') => {
    expect(await deliver(disputeEvent({ id: eventId, type }))).toEqual(ok('recorded'));
    expect(await apply.execute(system, {})).toMatchObject({ ok: true });
    return inbox.get(code, eventId)?.outcome;
  };
  const stored = () => [...disputes.rows.values()];

  describe('receive-stripe-event', () => {
    it.each([
      'charge.dispute.created',
      'charge.dispute.updated',
      'charge.dispute.funds_withdrawn',
      'charge.dispute.funds_reinstated',
      'charge.dispute.closed',
    ])('stores a signed %s once, by its dispute id', async (type) => {
      const event = disputeEvent({ type });

      expect(await deliver(event)).toEqual(ok('recorded'));
      expect(await deliver(event)).toEqual(ok('duplicate'));
      expect(inbox.get(code, 'evt_test_dp_0001')).toMatchObject({
        type,
        objectId: 'dp_test_0001',
        processedAt: null,
      });
    });

    it('ignores a dispute type payments does not act on', async () => {
      expect(await deliver(disputeEvent({ type: 'charge.dispute.something_new' }))).toEqual(
        ok('ignored'),
      );
      expect(inbox.rows.size).toBe(0);
    });

    it('refuses a live-mode dispute event and a malformed dispute object', async () => {
      expect(await deliver(disputeEvent({ livemode: true }))).toEqual(
        err({ code: 'payments.event-refused' }),
      );
      expect(await deliver(disputeEvent({ disputeId: 'ch_test_0001' }))).toEqual(
        err({ code: 'validation.failed' }),
      );
      const wrongObject = disputeEvent({});
      (wrongObject.data as { object: Record<string, unknown> }).object.object = 'charge';
      expect(await deliver(wrongObject)).toEqual(err({ code: 'validation.failed' }));
      expect(inbox.rows.size).toBe(0);
    });

    it('refuses a dispute event signed with the wrong secret before reading it', async () => {
      const body = Buffer.from(JSON.stringify(disputeEvent({})));
      const forged = stripeSignatureHeader(body, clock.now(), 'whsec_someone_else');
      expect(await receive.execute(anonymous, { payload: body, signature: forged })).toEqual(
        err({ code: 'payments.signature-invalid' }),
      );
      expect(inbox.rows.size).toBe(0);
    });
  });

  describe('apply-stripe-events (disputes)', () => {
    it('records a new dispute from what Stripe returns now and publishes version 1', async () => {
      reader.answer = ok(snapshot());

      expect(await applyEvent('evt_dp_1')).toBe('dispute-recorded');
      expect(reader.reads).toEqual(['dp_test_0001']);
      expect(stored()).toEqual([
        expect.objectContaining({
          market: code,
          providerDisputeId: 'dp_test_0001',
          orderId: ORDER,
          paymentIntentRef: 'pi_test_0001',
          amountMinor: 3000n,
          currency: currency.toUpperCase(),
          status: 'needs_response',
          reason: 'fraudulent',
          evidenceDueBy: DUE,
          fundsWithdrawn: false,
          fundsWithdrawnAt: null,
          fundsReinstated: false,
          outcome: null,
          openedAt: OPENED,
          version: 1,
        }),
      ]);
      const [row] = stored();
      expect(outbox.events).toEqual([
        expect.objectContaining({
          type: 'payments.dispute-changed.v1',
          aggregateType: 'dispute',
          aggregateId: row!.id,
          aggregateVersion: 1,
          payload: { disputeId: row!.id, orderId: ORDER },
        }),
      ]);
      // Nothing of ordering is called: intake moves no money.
      expect(ordering.confirms).toEqual([]);
      expect(ordering.cancels).toEqual([]);
    });

    it('records an inquiry the same way, with no money moved', async () => {
      reader.answer = ok(snapshot({ status: 'warning_needs_response' }));

      expect(await applyEvent('evt_dp_1')).toBe('dispute-recorded');
      expect(stored()[0]).toMatchObject({
        status: 'warning_needs_response',
        fundsWithdrawn: false,
      });
      const view = await disputeOf.execute(system, [stored()[0]!.id]);
      expect(view.ok && view.value[0]).toMatchObject({
        inquiry: true,
        closed: false,
        outcome: null,
      });
    });

    it('a repeated read that changes nothing stores and publishes nothing', async () => {
      reader.answer = ok(snapshot());
      await applyEvent('evt_dp_1');
      clock.advance(Temporal.Duration.from({ minutes: 1 }));

      expect(await applyEvent('evt_dp_2', 'charge.dispute.updated')).toBe('ignored');
      expect(stored()[0]!.version).toBe(1);
      expect(outbox.events).toHaveLength(1);
    });

    it('an inquiry closed without a chargeback is closed with no outcome', async () => {
      reader.answer = ok(snapshot({ status: 'warning_closed' }));
      await applyEvent('evt_dp_1', 'charge.dispute.closed');
      const view = await disputeOf.execute(system, [stored()[0]!.id]);
      expect(view.ok && view.value[0]).toMatchObject({
        inquiry: true,
        closed: true,
        outcome: null,
        fundsWithdrawn: false,
      });
    });

    it('withdrawal, reinstatement and a won close each raise the version once', async () => {
      reader.answer = ok(snapshot());
      await applyEvent('evt_dp_1');

      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      const withdrawnAt = clock.now();
      reader.answer = ok(snapshot({ fundsWithdrawn: true, status: 'under_review' }));
      expect(await applyEvent('evt_dp_2', 'charge.dispute.funds_withdrawn')).toBe(
        'dispute-recorded',
      );
      expect(stored()[0]).toMatchObject({
        status: 'under_review',
        fundsWithdrawn: true,
        fundsWithdrawnAt: withdrawnAt,
        version: 2,
      });

      clock.advance(Temporal.Duration.from({ hours: 480 }));
      const reinstatedAt = clock.now();
      reader.answer = ok(snapshot({ fundsWithdrawn: true, fundsReinstated: true, status: 'won' }));
      expect(await applyEvent('evt_dp_3', 'charge.dispute.closed')).toBe('dispute-recorded');
      expect(stored()[0]).toMatchObject({
        status: 'won',
        outcome: 'won',
        fundsWithdrawn: true,
        fundsWithdrawnAt: withdrawnAt,
        fundsReinstated: true,
        fundsReinstatedAt: reinstatedAt,
        version: 3,
      });
      expect(outbox.events.map((e) => e.aggregateVersion)).toEqual([1, 2, 3]);
    });

    it('a late read never takes back a withdrawal or a closed outcome', async () => {
      reader.answer = ok(snapshot({ fundsWithdrawn: true, status: 'lost' }));
      await applyEvent('evt_dp_1', 'charge.dispute.closed');
      expect(stored()[0]).toMatchObject({ outcome: 'lost', fundsWithdrawn: true });

      // Stripe's answer for an older event, read later: still needs a response, nothing withdrawn.
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      reader.answer = ok(snapshot({ fundsWithdrawn: false, status: 'needs_response' }));
      expect(await applyEvent('evt_dp_2', 'charge.dispute.updated')).toBe('ignored');
      expect(stored()[0]).toMatchObject({
        status: 'lost',
        outcome: 'lost',
        fundsWithdrawn: true,
        version: 1,
      });
    });

    it('a reinstatement read alone also records the withdrawal before it', async () => {
      reader.answer = ok(snapshot({ fundsReinstated: true, fundsWithdrawn: false }));
      await applyEvent('evt_dp_1', 'charge.dispute.funds_reinstated');
      expect(stored()[0]).toMatchObject({
        fundsWithdrawn: true,
        fundsWithdrawnAt: T0,
        fundsReinstated: true,
        fundsReinstatedAt: T0,
      });
    });

    it('stores a reason Stripe adds later as other, never as free text', async () => {
      reader.answer = ok(snapshot({ reason: 'a_reason_from_the_future' }));
      await applyEvent('evt_dp_1');
      expect(stored()[0]!.reason).toBe('other');
    });

    it("drops a dispute of another Market's order without storing it", async () => {
      reader.answer = ok(
        snapshot({
          paymentIntent: {
            id: 'pi_test_0001',
            metadataOrderId: ORDER,
            metadataMarketId: otherCode,
          },
        }),
      );
      expect(await applyEvent('evt_dp_1')).toBe('other-market');
      expect(stored()).toEqual([]);
      expect(outbox.events).toEqual([]);
      expect(securityEvents.events).toEqual([]);
    });

    it.each<[string, Partial<DisputeSnapshot>, string]>([
      ['a live-mode dispute', { livemode: true }, 'not-test-mode'],
      ['another dispute id', { id: 'dp_test_9999' }, 'malformed'],
      ['a charge with no PaymentIntent', { paymentIntent: null }, 'no-market'],
      [
        'a PaymentIntent with no Market',
        { paymentIntent: { id: 'pi_x', metadataOrderId: ORDER, metadataMarketId: null } },
        'no-market',
      ],
      [
        'a PaymentIntent with no order',
        { paymentIntent: { id: 'pi_x', metadataOrderId: null, metadataMarketId: code } },
        'malformed',
      ],
      [
        'an order id that is not a UUID',
        { paymentIntent: { id: 'pi_x', metadataOrderId: 'order-1', metadataMarketId: code } },
        'malformed',
      ],
      ['an unknown status', { status: 'escalated' }, 'malformed'],
      ['a zero amount', { amount: 0n }, 'malformed'],
      ['a malformed currency', { currency: 'AUD' }, 'malformed'],
    ])('rejects %s, stores nothing and raises a security event', async (_name, fields, reason) => {
      reader.answer = ok(snapshot(fields));
      expect(await applyEvent('evt_dp_1')).toBe('rejected');
      expect(stored()).toEqual([]);
      expect(outbox.events).toEqual([]);
      expect(securityEvents.events).toEqual([
        expect.objectContaining({
          type: 'payments.dispute.unmatched',
          payload: { reason },
          actor: 'system',
          marketId: code,
        }),
      ]);
    });

    it('rejects a read that changes what a stored dispute is about', async () => {
      reader.answer = ok(snapshot());
      await applyEvent('evt_dp_1');
      clock.advance(Temporal.Duration.from({ minutes: 1 }));
      reader.answer = ok(snapshot({ amount: 9999n, status: 'under_review' }));

      expect(await applyEvent('evt_dp_2', 'charge.dispute.updated')).toBe('rejected');
      expect(stored()[0]).toMatchObject({ amountMinor: 3000n, status: 'needs_response' });
      expect(securityEvents.events.map((e) => e.payload)).toEqual([{ reason: 'changed' }]);
    });

    it('tries again later when Stripe cannot be reached, and gives up on a refusal', async () => {
      reader.answer = err({ code: 'payment.provider-unavailable' });
      expect(await deliver(disputeEvent({ id: 'evt_dp_1' }))).toEqual(ok('recorded'));
      expect(await apply.execute(system, {})).toEqual(ok({ applied: 0, retried: 1, problems: [] }));
      expect(inbox.get(code, 'evt_dp_1')).toMatchObject({ processedAt: null, attempts: 1 });

      expect(securityEvents.events).toEqual([]);

      reader.answer = err({ code: 'payment.provider-rejected' });
      expect(await applyEvent('evt_dp_2')).toBe('rejected');
      expect(stored()).toEqual([]);
      expect(securityEvents.events.map((e) => e.payload)).toEqual([{ reason: 'unreadable' }]);
    });
  });

  describe('dispute-of', () => {
    it('answers the stored dispute of this Market and leaves unknown ids out', async () => {
      reader.answer = ok(snapshot());
      await applyEvent('evt_dp_1');
      const id = stored()[0]!.id;

      const answer = await disputeOf.execute(system, [id, '01990000-0000-7000-8000-00000000ffff']);
      expect(answer).toEqual(
        ok([
          {
            disputeId: id,
            orderId: ORDER,
            providerDisputeId: 'dp_test_0001',
            paymentIntentRef: 'pi_test_0001',
            amount: money(3000n, currency.toUpperCase()),
            status: 'needs_response',
            reason: 'fraudulent',
            inquiry: false,
            closed: false,
            evidenceDueBy: DUE,
            fundsWithdrawn: false,
            fundsWithdrawnAt: null,
            fundsReinstated: false,
            fundsReinstatedAt: null,
            outcome: null,
            openedAt: OPENED,
            version: 1,
          },
        ]),
      );
      const other = testCallContext(
        testMarketContext(otherCode, 'default'),
        'system',
        'dsp-x-abcd',
      );
      expect(await disputeOf.execute(other, [id])).toEqual(ok([]));
    });

    it('refuses more than 100 ids and an id that is not a UUID', async () => {
      const many = Array.from(
        { length: MAX_DISPUTE_IDS + 1 },
        (_, i) => `01990000-0000-7000-8000-${String(i).padStart(12, '0')}`,
      );
      expect(await disputeOf.execute(system, many)).toEqual(err({ code: 'validation.failed' }));
      expect(await disputeOf.execute(system, ['dp_test_0001'])).toEqual(
        err({ code: 'validation.failed' }),
      );
    });

    it('is a system rule: a signed-in or anonymous caller is refused', async () => {
      expect(DisputeOfQuery.access).toEqual({
        name: 'payments.dispute-of',
        rule: { kind: 'system' },
      });
      const query = new DisputeOfQuery(gate, {} as PaymentsDependencies);
      expect(await query.execute(anonymous, [])).toEqual(err({ code: 'access.denied' }));
    });
  });
});
