import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { PaymentsDependencies } from './payments-dependencies';
import { KEPT_EVENT_TYPES, type KeptEventType } from './ports/stripe-event-inbox';

export interface ReceiveInput {
  /** The exact bytes of the request body. */
  readonly payload: Uint8Array;
  /** The `Stripe-Signature` header as received. */
  readonly signature: unknown;
}

export type ReceiveOutcome =
  /** A kept event, stored to be applied by the worker. */
  | 'recorded'
  /** Its id is already stored: nothing changed. */
  | 'duplicate'
  /** A type payments does not act on: acknowledged, not stored. */
  | 'ignored'
  /** A kept type about another Market's session (Stripe sends every event to every endpoint). */
  | 'other-market';

export type ReceiveFailure =
  | AccessDenied
  /** No signing secret is configured: Stripe retries later. */
  | { readonly code: 'payments.webhook-unavailable' }
  | { readonly code: 'payments.signature-invalid' }
  | { readonly code: 'validation.failed' }
  /** Signed, but never for this platform now: a live-mode or connected-account event. */
  | { readonly code: 'payments.event-refused' };

const EVENT_ID = /^evt_[A-Za-z0-9_]{1,200}$/;
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,200}$/;
const MAX_TYPE_LENGTH = 100;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isKept = (type: string): type is KeptEventType =>
  (KEPT_EVENT_TYPES as readonly string[]).includes(type);

/** The body as JSON, or null: strict UTF-8, one object. */
function parse(payload: Uint8Array): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * `receive-stripe-event`: the signature is checked on the raw bytes before anything is read.
 * Then the event must be a test-mode event of the platform account (no connected account) and,
 * for the kept Checkout types, about a session of this Market (another Market's is acknowledged
 * and dropped). A kept event is stored once by
 * its id; nothing else is done here. The payload is used only to route the event: the worker
 * re-reads the session from Stripe before it acts.
 */
export async function receiveStripeEvent(
  deps: PaymentsDependencies,
  context: CallContext,
  input: ReceiveInput,
): Promise<Result<ReceiveOutcome, ReceiveFailure>> {
  const marketId = context.market.marketId;
  if (!deps.signature.configuredFor(marketId)) return err({ code: 'payments.webhook-unavailable' });
  if (!(input?.payload instanceof Uint8Array)) return err({ code: 'validation.failed' });
  if (!deps.signature.verify(marketId, input.payload, input.signature)) {
    return err({ code: 'payments.signature-invalid' });
  }
  const event = parse(input.payload);
  if (
    event === null ||
    typeof event.id !== 'string' ||
    !EVENT_ID.test(event.id) ||
    typeof event.type !== 'string' ||
    event.type.length === 0 ||
    event.type.length > MAX_TYPE_LENGTH ||
    typeof event.livemode !== 'boolean'
  ) {
    return err({ code: 'validation.failed' });
  }
  // Test mode only until the live gates are passed; Connect events come with package 3.
  if (event.livemode || (event.account !== undefined && event.account !== null)) {
    return err({ code: 'payments.event-refused' });
  }
  if (!isKept(event.type)) return ok('ignored');

  const object = isObject(event.data) ? event.data.object : undefined;
  if (
    !isObject(object) ||
    object.object !== 'checkout.session' ||
    typeof object.id !== 'string' ||
    !SESSION_ID.test(object.id)
  ) {
    return err({ code: 'validation.failed' });
  }
  const eventMarket = isObject(object.metadata) ? object.metadata.market_id : undefined;
  // Stripe delivers every event of the account to every endpoint: another Market's session (or
  // one ordering did not create) is acknowledged with 200 so Stripe does not retry it or disable
  // this endpoint; it is never stored here.
  if (eventMarket !== marketId) return ok('other-market');

  const received = { eventId: event.id, type: event.type, objectId: object.id };
  return deps.unitOfWork.run<ReceiveOutcome, ReceiveFailure>(context.market, async () =>
    ok(await deps.inbox.record(context.market, { ...received, receivedAt: deps.clock.now() })),
  );
}
