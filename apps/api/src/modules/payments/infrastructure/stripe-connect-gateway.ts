import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type {
  ConnectFailure,
  ConnectGateway,
  PayoutSchedule,
} from '../application/ports/connect-gateway';
import type { AccountSnapshot } from '../domain/connected-account';

/** How long one Stripe call may take before it counts as failed. */
export const STRIPE_CONNECT_TIMEOUT_MS = 10_000;
const STRIPE_API = 'https://api.stripe.com';
/** The Stripe version the v2 calls are pinned to (v2 requires one; v1 calls use the account's). */
export const STRIPE_V2_VERSION = '2026-09-30.endive';
const ACCOUNT_ID = /^acct_[A-Za-z0-9_]{1,200}$/;
const LINK_URL = /^https:\/\/connect\.stripe\.com\/[^\s]*$/;

/** `fetch`, narrowed to what the gateway uses, so tests can pass a fake. */
export type StripeRequest = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

const UNAVAILABLE: ConnectFailure = Object.freeze({
  code: 'payment.provider-unavailable' as const,
});
/** Stripe answered with an error status: it caches that answer under the same key for 24 h. */
const UNAVAILABLE_ANSWERED: ConnectFailure = Object.freeze({
  code: 'payment.provider-unavailable' as const,
  answered: true,
});
const REJECTED: ConnectFailure = Object.freeze({ code: 'payment.provider-rejected' as const });

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const count = (value: unknown): number => (Array.isArray(value) ? value.length : 0);

/**
 * Stripe Connect over the REST API with `fetch` (no SDK), test mode only. One request per call,
 * never retried here: a money-creating call is repeated only by the caller, with the same
 * idempotency key. The secret key and Stripe's answer bodies never reach a log or an error: a
 * failure is a code only.
 */
export class StripeConnectGateway implements ConnectGateway {
  constructor(
    private readonly secretKey: string | null,
    private readonly requestFn: StripeRequest = (url, init) => fetch(url, init),
    private readonly timeoutMs: number = STRIPE_CONNECT_TIMEOUT_MS,
  ) {}

  async createAccount(request: {
    idempotencyKey: string;
    country: string;
    marketId: string;
    sellerId: string;
    contactEmail: string;
  }): Promise<Result<{ accountRef: string }, ConnectFailure>> {
    // Accounts v2 (Stripe refuses Accounts v1 creation for a new Connect platform): the Express
    // Dashboard, the platform pays fees and bears losses, and the recipient configuration with
    // `stripe_balance.stripe_transfers`, which receives the separate transfers (payments.md 4.6).
    // Stripe requires the contact email with the recipient configuration; it is sent here only.
    const body = await this.call(
      'POST',
      '/v2/core/accounts',
      {
        contact_email: request.contactEmail,
        dashboard: 'express',
        identity: { country: request.country },
        defaults: {
          responsibilities: { fees_collector: 'application', losses_collector: 'application' },
        },
        configuration: {
          recipient: {
            capabilities: { stripe_balance: { stripe_transfers: { requested: true } } },
          },
        },
        metadata: { market_id: request.marketId, seller_id: request.sellerId },
      },
      request.idempotencyKey,
    );
    if (!body.ok) return body;
    const id = isObject(body.value) ? text(body.value.id) : null;
    return id !== null && ACCOUNT_ID.test(id) ? ok({ accountRef: id }) : err(UNAVAILABLE);
  }

  async createAccountLink(request: {
    accountRef: string;
    kind: 'onboarding' | 'update';
    returnUrl: string;
    refreshUrl: string;
  }): Promise<Result<{ url: string }, ConnectFailure>> {
    if (!ACCOUNT_ID.test(request.accountRef)) return err(REJECTED);
    const form = new URLSearchParams();
    form.set('account', request.accountRef);
    form.set('type', request.kind === 'onboarding' ? 'account_onboarding' : 'account_update');
    form.set('return_url', request.returnUrl);
    form.set('refresh_url', request.refreshUrl);
    const body = await this.call('POST', '/v1/account_links', form, null);
    if (!body.ok) return body;
    const url = isObject(body.value) ? text(body.value.url) : null;
    return url !== null && LINK_URL.test(url) ? ok({ url }) : err(UNAVAILABLE);
  }

  async readAccount(accountRef: string): Promise<Result<AccountSnapshot, ConnectFailure>> {
    if (!ACCOUNT_ID.test(accountRef)) return err(REJECTED);
    const body = await this.call('GET', `/v1/accounts/${accountRef}`, null, null);
    if (!body.ok) return body;
    const snapshot = toSnapshot(body.value);
    return snapshot === null ? err(UNAVAILABLE) : ok(snapshot);
  }

  async setPayoutSchedule(
    accountRef: string,
    schedule: PayoutSchedule,
    idempotencyKey: string,
  ): Promise<Result<void, ConnectFailure>> {
    if (!ACCOUNT_ID.test(accountRef)) return err(REJECTED);
    // The Balance Settings API on the connected account (an Accounts v2 account's payout schedule
    // is not set through the v1 account).
    const form = new URLSearchParams();
    form.set('payments[payouts][schedule][interval]', schedule);
    const body = await this.call('POST', '/v1/balance_settings', form, idempotencyKey, accountRef);
    return body.ok ? ok(undefined) : body;
  }

  /**
   * One Stripe call. A v1 call takes a form; a v2 call (`/v2/...`) takes a JSON body and the
   * pinned Stripe version. `onAccount` sends the call as the connected account (Stripe-Account).
   */
  private async call(
    method: 'GET' | 'POST',
    path: string,
    payload: URLSearchParams | Record<string, unknown> | null,
    idempotencyKey: string | null,
    onAccount: string | null = null,
  ): Promise<Result<unknown, ConnectFailure>> {
    if (this.secretKey === null) return err(UNAVAILABLE);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
      let body: string | undefined;
      if (path.startsWith('/v2/')) headers['Stripe-Version'] = STRIPE_V2_VERSION;
      if (payload instanceof URLSearchParams) {
        headers['Content-Type'] = 'application/x-www-form-urlencoded';
        body = payload.toString();
      } else if (payload !== null) {
        headers['Content-Type'] = 'application/json';
        body = JSON.stringify(payload);
      }
      if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey;
      if (onAccount !== null) headers['Stripe-Account'] = onAccount;
      const response = await this.requestFn(`${STRIPE_API}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
        signal: timeout.signal,
      });
      if (response.status >= 500 || response.status === 429) return err(UNAVAILABLE_ANSWERED);
      if (response.status >= 400) return err(REJECTED);
      return ok(await response.json());
    } catch {
      return err(UNAVAILABLE);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** How many external accounts the object lists; a further page counts as more than one. */
function externalCount(value: unknown): number | null {
  if (!isObject(value) || !Array.isArray(value.data)) return null;
  return value.has_more === true ? Math.max(2, value.data.length) : value.data.length;
}

/**
 * The Stripe id of the default external account (`default_for_currency`), or null when none is
 * shown. It is for the keyed hash only: it is never stored, logged or returned.
 */
function defaultExternalAccountId(value: unknown): string | null {
  if (!isObject(value) || !Array.isArray(value.data)) return null;
  for (const item of value.data) {
    if (isObject(item) && item.default_for_currency === true) {
      const id = text(item.id);
      if (id !== null && id.length > 0) return id;
    }
  }
  return null;
}

/** Stripe's account object, narrowed; null when it is not a well-formed account. */
function toSnapshot(body: unknown): AccountSnapshot | null {
  if (
    !isObject(body) ||
    body.object !== 'account' ||
    typeof body.id !== 'string' ||
    !ACCOUNT_ID.test(body.id) ||
    typeof body.details_submitted !== 'boolean' ||
    typeof body.payouts_enabled !== 'boolean'
  ) {
    return null;
  }
  const metadata = isObject(body.metadata) ? body.metadata : {};
  const capabilities = isObject(body.capabilities) ? body.capabilities : {};
  const requirements = isObject(body.requirements) ? body.requirements : {};
  const settings = isObject(body.settings) ? body.settings : {};
  const payouts = isObject(settings.payouts) ? settings.payouts : {};
  const schedule = isObject(payouts.schedule) ? payouts.schedule : {};
  return {
    id: body.id,
    metadataMarketId: text(metadata.market_id),
    metadataSellerId: text(metadata.seller_id),
    detailsSubmitted: body.details_submitted,
    transfersActive: capabilities.transfers === 'active',
    payoutsEnabled: body.payouts_enabled,
    requirementsDue: count(requirements.currently_due),
    requirementsPastDue: count(requirements.past_due) > 0,
    disabledReason: text(requirements.disabled_reason),
    payoutScheduleInterval: text(schedule.interval),
    externalAccountCount: externalCount(body.external_accounts),
    defaultExternalAccountId: defaultExternalAccountId(body.external_accounts),
  };
}
