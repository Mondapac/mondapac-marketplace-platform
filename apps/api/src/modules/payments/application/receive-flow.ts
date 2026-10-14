import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import { isExternalAccountEvent } from '../domain/payout-change';
import type { PaymentsDependencies } from './payments-dependencies';
import {
  ACCOUNT_EVENT_TYPES,
  CHECKOUT_EVENT_TYPES,
  type KeptEventType,
} from './ports/stripe-event-inbox';

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
  /** Signed, but never for this platform now: a live-mode event, or one of the wrong endpoint kind. */
  | { readonly code: 'payments.event-refused' };

const EVENT_ID = /^evt_[A-Za-z0-9_]{1,200}$/;
const SESSION_ID = /^cs_[A-Za-z0-9_]{1,200}$/;
const ACCOUNT_ID = /^acct_[A-Za-z0-9_]{1,200}$/;
const MAX_TYPE_LENGTH = 100;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isKept = (type: string, kinds: readonly string[]): type is KeptEventType =>
  kinds.includes(type);

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
 * Then the event must be a test-mode event: a platform event (no connected account) of a kept
 * Checkout type about a session of this Market, or, signed with the Connect secret, an account
 * event of a connected account (another Market's is acknowledged and dropped). A kept event is
 * stored once by its id; nothing else is done here. The payload is used only to route the event:
 * the worker re-reads the session or account from Stripe before it acts.
 */
export async function receiveStripeEvent(
  deps: PaymentsDependencies,
  context: CallContext,
  input: ReceiveInput,
): Promise<Result<ReceiveOutcome, ReceiveFailure>> {
  const marketId = context.market.marketId;
  if (!deps.signature.configuredFor(marketId)) return err({ code: 'payments.webhook-unavailable' });
  if (!(input?.payload instanceof Uint8Array)) return err({ code: 'validation.failed' });
  const kind = deps.signature.verify(marketId, input.payload, input.signature);
  if (kind === null) return err({ code: 'payments.signature-invalid' });
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
  // Test mode only until the live gates are passed. A platform event never names a connected
  // account, and a Connect event always does: the secret that signed it must fit the shape.
  const account = event.account;
  if (event.livemode) return err({ code: 'payments.event-refused' });
  const hasAccount = account !== undefined && account !== null;
  if (kind === 'platform' ? hasAccount : typeof account !== 'string' || !ACCOUNT_ID.test(account)) {
    return err({ code: 'payments.event-refused' });
  }
  const kept = kind === 'platform' ? CHECKOUT_EVENT_TYPES : ACCOUNT_EVENT_TYPES;
  if (!isKept(event.type, kept)) return ok('ignored');

  const object = isObject(event.data) ? event.data.object : undefined;
  if (!isObject(object)) return err({ code: 'validation.failed' });
  let objectId: string;
  if (kind === 'platform') {
    if (
      object.object !== 'checkout.session' ||
      typeof object.id !== 'string' ||
      !SESSION_ID.test(object.id)
    ) {
      return err({ code: 'validation.failed' });
    }
    objectId = object.id;
    const eventMarket = isObject(object.metadata) ? object.metadata.market_id : undefined;
    // Stripe delivers every event of the account to every endpoint: another Market's session (or
    // one ordering did not create) is acknowledged with 200 so Stripe does not retry it or
    // disable this endpoint; it is never stored here.
    if (eventMarket !== marketId) return ok('other-market');
  } else {
    // The account is the one that signed the event's `account` field; its Market and seller are
    // checked against Stripe's own answer when the worker reads it again. An `account.updated`
    // payload carries the metadata, so another Market's account is dropped here already; the
    // other types carry none, so the worker's read of the account decides.
    if (typeof account !== 'string') return err({ code: 'validation.failed' });
    objectId = account;
    if (event.type === 'account.updated') {
      if (object.object !== 'account' || object.id !== account) {
        return err({ code: 'validation.failed' });
      }
      const eventMarket = isObject(object.metadata) ? object.metadata.market_id : undefined;
      if (eventMarket !== marketId) return ok('other-market');
    } else if (isExternalAccountEvent(event.type)) {
      // A bank account (or card) of the account; nothing of it is read from the payload.
      if (
        (object.object !== 'bank_account' && object.object !== 'card') ||
        object.account !== account
      ) {
        return err({ code: 'validation.failed' });
      }
    } else if (object.object !== 'capability' || object.account !== account) {
      return err({ code: 'validation.failed' });
    }
  }

  const received = { eventId: event.id, type: event.type, objectId };
  return deps.unitOfWork.run<ReceiveOutcome, ReceiveFailure>(context.market, async () =>
    ok(await deps.inbox.record(context.market, { ...received, receivedAt: deps.clock.now() })),
  );
}
