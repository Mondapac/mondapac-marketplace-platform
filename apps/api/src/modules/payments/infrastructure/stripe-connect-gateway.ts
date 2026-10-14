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
  }): Promise<Result<{ accountRef: string }, ConnectFailure>> {
    const form = new URLSearchParams();
    form.set('type', 'express');
    form.set('country', request.country);
    form.set('capabilities[transfers][requested]', 'true');
    form.set('metadata[market_id]', request.marketId);
    form.set('metadata[seller_id]', request.sellerId);
    const body = await this.call('POST', '/v1/accounts', form, request.idempotencyKey);
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
    const form = new URLSearchParams();
    form.set('settings[payouts][schedule][interval]', schedule);
    const body = await this.call('POST', `/v1/accounts/${accountRef}`, form, idempotencyKey);
    return body.ok ? ok(undefined) : body;
  }

  private async call(
    method: 'GET' | 'POST',
    path: string,
    form: URLSearchParams | null,
    idempotencyKey: string | null,
  ): Promise<Result<unknown, ConnectFailure>> {
    if (this.secretKey === null) return err(UNAVAILABLE);
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), this.timeoutMs);
    try {
      const headers: Record<string, string> = { Authorization: `Bearer ${this.secretKey}` };
      if (form !== null) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      if (idempotencyKey !== null) headers['Idempotency-Key'] = idempotencyKey;
      const response = await this.requestFn(`${STRIPE_API}${path}`, {
        method,
        headers,
        ...(form === null ? {} : { body: form.toString() }),
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
  };
}
