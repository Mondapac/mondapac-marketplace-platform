import { err, ok, Temporal } from '@mondapac/shared-kernel';
import type {
  DisputeSnapshot,
  StripeDisputeReader,
} from '../application/ports/stripe-dispute-reader';
import type { ReadFailure } from '../application/ports/stripe-session-reader';
import { STRIPE_READ_TIMEOUT_MS, type StripeGet } from './stripe-session-reader';

const STRIPE_API = 'https://api.stripe.com';
const DISPUTE_ID = /^(dp|du)_[A-Za-z0-9_]{1,200}$/;
const INTENT_ID = /^pi_[A-Za-z0-9_]{1,200}$/;
/** Unix seconds Stripe can send: 2000-01-01 to 2100-01-01. */
const MIN_SECONDS = 946_684_800;
const MAX_SECONDS = 4_102_444_800;

const UNAVAILABLE: ReadFailure = Object.freeze({ code: 'payment.provider-unavailable' as const });
const REJECTED: ReadFailure = Object.freeze({ code: 'payment.provider-rejected' as const });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const instant = (value: unknown): Temporal.Instant | null =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= MIN_SECONDS &&
  value <= MAX_SECONDS
    ? Temporal.Instant.fromEpochMilliseconds(value * 1000)
    : null;

/**
 * Reads a dispute, with its PaymentIntent expanded, over Stripe's REST API with `fetch` (no SDK).
 * One request, never retried here. Only the fields payments needs are kept: the evidence, the
 * buyer's claim, the charge's card details and the PaymentIntent's other fields are never read.
 * The secret key and Stripe's answer bodies never reach a log or an error: a failure is a code.
 */
export class StripeDisputeApiReader implements StripeDisputeReader {
  constructor(
    private readonly secretKey: string | null,
    private readonly fetchFn: StripeGet = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = STRIPE_READ_TIMEOUT_MS,
  ) {}

  async readDispute(disputeId: string) {
    if (!DISPUTE_ID.test(disputeId)) return err(REJECTED);
    if (this.secretKey === null) return err(UNAVAILABLE);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    let body: unknown;
    try {
      const response = await this.fetchFn(
        `${STRIPE_API}/v1/disputes/${disputeId}?expand[]=payment_intent`,
        {
          method: 'GET',
          headers: { Authorization: `Bearer ${this.secretKey}` },
          signal: timeout.signal,
        },
      );
      if (response.status >= 500 || response.status === 429) return err(UNAVAILABLE);
      if (response.status >= 400) return err(REJECTED);
      body = await response.json();
    } catch {
      return err(UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }
    const snapshot = toSnapshot(body);
    return snapshot === null ? err(UNAVAILABLE) : ok(snapshot);
  }
}

/** Stripe's dispute object, narrowed; null when it is not a well-formed dispute. */
function toSnapshot(body: unknown): DisputeSnapshot | null {
  if (
    !isObject(body) ||
    body.object !== 'dispute' ||
    typeof body.id !== 'string' ||
    typeof body.livemode !== 'boolean' ||
    typeof body.status !== 'string' ||
    typeof body.reason !== 'string' ||
    typeof body.currency !== 'string' ||
    typeof body.amount !== 'number' ||
    !Number.isSafeInteger(body.amount) ||
    !Array.isArray(body.balance_transactions)
  ) {
    return null;
  }
  const openedAt = instant(body.created);
  if (openedAt === null) return null;
  const evidence = isObject(body.evidence_details) ? body.evidence_details : {};
  let evidenceDueBy: Temporal.Instant | null = null;
  if (evidence.due_by !== null && evidence.due_by !== undefined) {
    evidenceDueBy = instant(evidence.due_by);
    if (evidenceDueBy === null) return null;
  }
  // The money moves are read from the balance transactions Stripe lists on the dispute: their
  // category only, never an amount or a fee.
  const categories = new Set<string>();
  for (const transaction of body.balance_transactions) {
    if (!isObject(transaction)) return null;
    const category = text(transaction.reporting_category);
    if (category !== null) categories.add(category);
  }
  let paymentIntent: DisputeSnapshot['paymentIntent'] = null;
  if (body.payment_intent !== null && body.payment_intent !== undefined) {
    const intent = body.payment_intent;
    if (!isObject(intent) || typeof intent.id !== 'string' || !INTENT_ID.test(intent.id)) {
      return null;
    }
    const metadata = isObject(intent.metadata) ? intent.metadata : {};
    paymentIntent = {
      id: intent.id,
      metadataOrderId: text(metadata.order_id),
      metadataMarketId: text(metadata.market_id),
    };
  }
  return {
    id: body.id,
    livemode: body.livemode,
    status: body.status,
    reason: body.reason,
    amount: BigInt(body.amount),
    currency: body.currency,
    openedAt,
    evidenceDueBy,
    fundsWithdrawn: categories.has('dispute'),
    fundsReinstated: categories.has('dispute_reversal'),
    paymentIntent,
  };
}
