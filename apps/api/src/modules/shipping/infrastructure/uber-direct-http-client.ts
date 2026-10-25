import { err, ok } from '@mondapac/shared-kernel';
import type { Clock, Result } from '@mondapac/shared-kernel';
import type { CircuitBreaker, CircuitBreakerSettings } from './circuit-breaker';
import { boundedJson, type DriveFetch, type Sleep } from './drive-http-client';

/** `fetch`, narrowed as the Drive client's is, so tests can pass a fake. */
export type UberFetch = DriveFetch;

/** Uber's OAuth token endpoint and API root (Direct API docs); fixed, never from configuration. */
export const UBER_AUTH_URL = 'https://auth.uber.com/oauth/v2/token';
export const UBER_API_URL = 'https://api.uber.com/v1/customers';

/** A token is replaced this long before it expires, so a call never leaves with a dying one. */
export const TOKEN_EARLY_REFRESH_MS = 60_000;

/** One Market's Uber Direct connection. Holds the client secret: never logged or put in an error. */
export interface UberDirectEndpoint {
  readonly marketId: string;
  readonly authUrl: string;
  /** The API root; the customer id and the path are appended. */
  readonly apiUrl: string;
  readonly customerId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  /** How long one attempt may take. */
  readonly timeoutMs: number;
  /** Attempts of one call, the first included. */
  readonly maxAttempts: number;
  /** The first retry waits this long; each next one twice as long. */
  readonly backoffMs: number;
  readonly circuit: CircuitBreakerSettings;
}

export type UberCallFailure = 'unavailable' | 'refused';
export type UberCallKind = 'quote' | 'book' | 'cancel' | 'status' | 'token';

interface CachedToken {
  readonly token: string;
  /** Epoch milliseconds from which the token is no longer used. */
  readonly usableUntil: number;
}

type Attempt =
  { kind: 'answer'; status: number; body: unknown } | { kind: 'fault'; throttled: boolean };

/**
 * The HTTP client of the Uber Direct API: JSON over HTTPS with an OAuth2 client-credentials
 * bearer token (scope `eats.deliveries`) that is kept per Market until shortly before it expires
 * and replaced once when a call is answered 401. Each attempt has a timeout; a 5xx, a timeout or
 * a network fault is retried (a 429 too, except on a quote) with exponential backoff, a 4xx never
 * is. Every call the marketplace makes is idempotent (a booking carries the seller order id as
 * `external_id`). A circuit breaker per Market and kind of call stops calls while Uber is down.
 * The secret, the token and Uber's answer bodies never reach a log or an error: a failure is a
 * code.
 */
export class UberDirectHttpClient {
  readonly #tokens = new Map<string, CachedToken>();
  readonly #fetching = new Map<string, Promise<Result<string, UberCallFailure>>>();

  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly clock: Clock,
    private readonly fetchFn: UberFetch = (url, init) => fetch(url, init),
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** `path` is relative to the customer, e.g. `deliveries/del_x/cancel`. */
  post(
    endpoint: UberDirectEndpoint,
    path: string,
    body: unknown,
    call: 'book' | 'cancel' | 'quote',
  ): Promise<Result<{ readonly status: number; readonly body: unknown }, UberCallFailure>> {
    return this.call(endpoint, 'POST', path, JSON.stringify(body), call);
  }

  get(
    endpoint: UberDirectEndpoint,
    path: string,
  ): Promise<Result<{ readonly status: number; readonly body: unknown }, UberCallFailure>> {
    return this.call(endpoint, 'GET', path, undefined, 'status');
  }

  private async call(
    endpoint: UberDirectEndpoint,
    method: 'GET' | 'POST',
    path: string,
    payload: string | undefined,
    call: UberCallKind,
  ): Promise<Result<{ readonly status: number; readonly body: unknown }, UberCallFailure>> {
    const key = `${endpoint.marketId}|${endpoint.customerId}|${call}`;
    if (!this.breaker.allow(key)) return err('unavailable');
    const url = `${endpoint.apiUrl.replace(/\/+$/, '')}/${encodeURIComponent(endpoint.customerId)}/${path}`;
    let refreshed = false;
    for (let attempt = 1; ; attempt += 1) {
      const token = await this.token(endpoint);
      if (!token.ok) {
        // The token call keeps its own circuit and has already retried; a half-open trial of
        // this call's circuit must still be settled.
        this.breaker.failed(key, endpoint.circuit);
        return err('unavailable');
      }
      const answer = await this.once(endpoint, method, url, payload, {
        accept: 'application/json',
        authorization: `Bearer ${token.value}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      });
      if (answer.kind === 'answer') {
        if (answer.status === 401) {
          // The token was revoked or expired early: one new token, then the same call again.
          this.#tokens.delete(this.tokenKey(endpoint));
          if (!refreshed) {
            refreshed = true;
            attempt -= 1;
            continue;
          }
        }
        // A 4xx is Uber's decision about the request, not a fault of Uber.
        this.breaker.succeeded(key);
        return answer.status < 400
          ? ok({ status: answer.status, body: answer.body })
          : err('refused');
      }
      // A quote waits on a customer at checkout: a 429 falls back at once instead of adding
      // retries while Uber sheds load.
      if (attempt >= endpoint.maxAttempts || (answer.throttled && call === 'quote')) {
        this.breaker.failed(key, endpoint.circuit);
        return err('unavailable');
      }
      await this.sleep(endpoint.backoffMs * 2 ** (attempt - 1));
    }
  }

  private tokenKey(endpoint: UberDirectEndpoint): string {
    return `${endpoint.marketId}|${endpoint.customerId}|${endpoint.clientId}`;
  }

  /** The cached token, or a new one (concurrent callers share one request). */
  private token(endpoint: UberDirectEndpoint): Promise<Result<string, UberCallFailure>> {
    const key = this.tokenKey(endpoint);
    const cached = this.#tokens.get(key);
    if (cached !== undefined && this.clock.now().epochMilliseconds < cached.usableUntil) {
      return Promise.resolve(ok(cached.token));
    }
    const running = this.#fetching.get(key);
    if (running !== undefined) return running;
    const fetching = this.fetchToken(endpoint, key).finally(() => this.#fetching.delete(key));
    this.#fetching.set(key, fetching);
    return fetching;
  }

  /**
   * `POST` to the OAuth endpoint with the client credentials. Retried like any idempotent call.
   * A refusal (bad credentials) is "unavailable" to the caller, not "refused": the request itself
   * was not judged, and it can succeed once the credentials are fixed.
   */
  private async fetchToken(
    endpoint: UberDirectEndpoint,
    cacheKey: string,
  ): Promise<Result<string, UberCallFailure>> {
    const key = `${endpoint.marketId}|${endpoint.customerId}|token`;
    if (!this.breaker.allow(key)) return err('unavailable');
    const form = new URLSearchParams({
      client_id: endpoint.clientId,
      client_secret: endpoint.clientSecret,
      grant_type: 'client_credentials',
      scope: 'eats.deliveries',
    }).toString();
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.once(endpoint, 'POST', endpoint.authUrl, form, {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      });
      if (answer.kind === 'answer') {
        const granted = this.grantOf(answer.status, answer.body);
        if (granted === null) {
          this.breaker.failed(key, endpoint.circuit);
          return err('unavailable');
        }
        this.breaker.succeeded(key);
        this.#tokens.set(cacheKey, {
          token: granted.token,
          usableUntil:
            this.clock.now().epochMilliseconds + granted.expiresInMs - TOKEN_EARLY_REFRESH_MS,
        });
        return ok(granted.token);
      }
      if (attempt >= endpoint.maxAttempts) {
        this.breaker.failed(key, endpoint.circuit);
        return err('unavailable');
      }
      await this.sleep(endpoint.backoffMs * 2 ** (attempt - 1));
    }
  }

  /** The token and its life from Uber's answer, or null when it is not a usable grant. */
  private grantOf(status: number, body: unknown): { token: string; expiresInMs: number } | null {
    if (status >= 400 || typeof body !== 'object' || body === null) return null;
    const { access_token: token, expires_in: expiresIn } = body as Record<string, unknown>;
    if (typeof token !== 'string' || !/^[\x21-\x7e]{8,4096}$/.test(token)) return null;
    // A life that does not outlast the early refresh would loop on tokens: not a usable grant.
    if (
      typeof expiresIn !== 'number' ||
      !Number.isFinite(expiresIn) ||
      expiresIn * 1000 <= TOKEN_EARLY_REFRESH_MS * 2
    ) {
      return null;
    }
    return { token, expiresInMs: Math.min(expiresIn, 86_400 * 31) * 1000 };
  }

  private async once(
    endpoint: UberDirectEndpoint,
    method: 'GET' | 'POST',
    url: string,
    payload: string | undefined,
    headers: Record<string, string>,
  ): Promise<Attempt> {
    try {
      const response = await this.fetchFn(url, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
        redirect: 'error',
      });
      // A 429 is Uber shedding load, not a judgement of the request: it counts towards the
      // circuit like a 5xx and is retried on everything but a quote.
      if (response.status >= 500 || response.status === 429) {
        await response.body?.cancel();
        return { kind: 'fault', throttled: response.status === 429 };
      }
      return { kind: 'answer', status: response.status, body: await boundedJson(response.body) };
    } catch {
      return { kind: 'fault', throttled: false };
    }
  }
}
