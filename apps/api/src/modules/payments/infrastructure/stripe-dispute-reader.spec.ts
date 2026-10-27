import { Temporal } from '@mondapac/shared-kernel';
import { StripeDisputeApiReader } from './stripe-dispute-reader';
import type { StripeGet } from './stripe-session-reader';

// The dispute reader against a fake `fetch`: the exact request (GET, the expanded PaymentIntent,
// the key only in the Authorization header), the narrowing of Stripe's answer (money moves from
// the balance transactions' categories, never the evidence or card details), and every failure
// as a code without Stripe's text.

const KEY = 'sk_test_abcdefgh12345678';
const CREATED = 1_761_465_600; // 2025-10-26T08:00:00Z
const DUE_BY = 1_762_387_199;

const answer = (status: number, body: unknown) => () =>
  Promise.resolve({ status, json: () => Promise.resolve(body) });

const DISPUTE = {
  id: 'dp_test_a1',
  object: 'dispute',
  livemode: false,
  amount: 3000,
  currency: 'aud',
  status: 'needs_response',
  reason: 'fraudulent',
  created: CREATED,
  charge: 'ch_test_c3',
  evidence: { customer_name: 'should not be kept', uncategorized_text: 'nor this' },
  evidence_details: { due_by: DUE_BY, has_evidence: false, submission_count: 0 },
  balance_transactions: [] as unknown[],
  payment_intent: {
    id: 'pi_test_b2',
    object: 'payment_intent',
    metadata: { order_id: 'order-1', market_id: 'AU' },
    payment_method: 'pm_card_should_not_be_kept',
  },
};

describe('StripeDisputeApiReader', () => {
  it('reads the dispute with its PaymentIntent and keeps only what payments needs', async () => {
    const calls: { url: string; init: Parameters<StripeGet>[1] }[] = [];
    const reader = new StripeDisputeApiReader(KEY, (url, init) => {
      calls.push({ url, init });
      return answer(200, DISPUTE)();
    });

    expect(await reader.readDispute('dp_test_a1')).toEqual({
      ok: true,
      value: {
        id: 'dp_test_a1',
        livemode: false,
        status: 'needs_response',
        reason: 'fraudulent',
        amount: 3000n,
        currency: 'aud',
        openedAt: Temporal.Instant.fromEpochMilliseconds(CREATED * 1000),
        evidenceDueBy: Temporal.Instant.fromEpochMilliseconds(DUE_BY * 1000),
        fundsWithdrawn: false,
        fundsReinstated: false,
        paymentIntent: { id: 'pi_test_b2', metadataOrderId: 'order-1', metadataMarketId: 'AU' },
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(
      'https://api.stripe.com/v1/disputes/dp_test_a1?expand[]=payment_intent',
    );
    expect(calls[0]!.init.method).toBe('GET');
    expect(calls[0]!.init.headers).toEqual({ Authorization: `Bearer ${KEY}` });
  });

  it('reads the withdrawal and the reinstatement from the balance transactions', async () => {
    const body = {
      ...DISPUTE,
      balance_transactions: [
        { id: 'txn_1', amount: -3000, fee: -2500, reporting_category: 'dispute' },
        { id: 'txn_2', amount: 3000, fee: 0, reporting_category: 'dispute_reversal' },
      ],
    };
    const read = await new StripeDisputeApiReader(KEY, answer(200, body)).readDispute('dp_test_a1');
    expect(read.ok && read.value).toMatchObject({ fundsWithdrawn: true, fundsReinstated: true });
  });

  it('keeps a dispute with no deadline and no PaymentIntent', async () => {
    const body = { ...DISPUTE, evidence_details: { due_by: null }, payment_intent: null };
    const read = await new StripeDisputeApiReader(KEY, answer(200, body)).readDispute('dp_test_a1');
    expect(read.ok && read.value).toMatchObject({ evidenceDueBy: null, paymentIntent: null });
  });

  it.each<[string, unknown]>([
    ['another object', { ...DISPUTE, object: 'charge' }],
    ['a fractional amount', { ...DISPUTE, amount: 1.5 }],
    ['no balance transactions list', { ...DISPUTE, balance_transactions: null }],
    ['an opening instant out of range', { ...DISPUTE, created: 12 }],
    ['a malformed deadline', { ...DISPUTE, evidence_details: { due_by: 'soon' } }],
    ['an unexpanded PaymentIntent', { ...DISPUTE, payment_intent: 'pi_test_b2' }],
    ['not an object', ['dispute']],
  ])('answers unavailable for %s', async (_name, body) => {
    expect(
      await new StripeDisputeApiReader(KEY, answer(200, body)).readDispute('dp_test_a1'),
    ).toEqual({ ok: false, error: { code: 'payment.provider-unavailable' } });
  });

  it('maps Stripe errors to codes and never calls Stripe for a malformed id or without a key', async () => {
    const unavailable = { ok: false, error: { code: 'payment.provider-unavailable' } };
    const rejected = { ok: false, error: { code: 'payment.provider-rejected' } };
    expect(await new StripeDisputeApiReader(KEY, answer(503, {})).readDispute('dp_a')).toEqual(
      unavailable,
    );
    expect(await new StripeDisputeApiReader(KEY, answer(429, {})).readDispute('dp_a')).toEqual(
      unavailable,
    );
    expect(await new StripeDisputeApiReader(KEY, answer(404, {})).readDispute('dp_a')).toEqual(
      rejected,
    );
    expect(
      await new StripeDisputeApiReader(KEY, () => Promise.reject(new Error('reset'))).readDispute(
        'dp_a',
      ),
    ).toEqual(unavailable);
    const never: StripeGet = () => {
      throw new Error('must not be called');
    };
    expect(await new StripeDisputeApiReader(KEY, never).readDispute('dp_a/../x')).toEqual(rejected);
    expect(await new StripeDisputeApiReader(null, never).readDispute('dp_a')).toEqual(unavailable);
  });
});
