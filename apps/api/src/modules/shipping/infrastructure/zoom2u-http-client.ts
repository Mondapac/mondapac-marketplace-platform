import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { CircuitBreaker, CircuitBreakerSettings } from './circuit-breaker';
import { boundedJson, type DriveFetch, type Sleep } from './drive-http-client';

/** `fetch`, narrowed as the Drive client's is, so tests can pass a fake. */
export type Zoom2uFetch = DriveFetch;

export type Zoom2uEnvironment = 'sandbox' | 'production';

/**
 * Zoom2u's API hosts (developer.zoom2u.com); fixed, never from configuration. Zoom2u documents
 * ONE host: a key used for testing marks its bookings TEST (not shown to couriers, not invoiced)
 * until "Go Live" is pressed in the Zoom2u account. Both environments therefore name that host
 * today; the table is where a separate sandbox host goes if Zoom2u publishes one.
 */
export const ZOOM2U_API_URLS: Readonly<Record<Zoom2uEnvironment, string>> = Object.freeze({
  production: 'https://api.zoom2u.com',
  sandbox: 'https://api.zoom2u.com',
});

/** The path every Zoom2u call lives under. */
export const ZOOM2U_API_PREFIX = '/api/v1/delivery';

/** One Market's Zoom2u connection. Holds the API key: never logged or put in an error. */
export interface Zoom2uEndpoint {
  readonly marketId: string;
  /** The API host, one of {@link ZOOM2U_API_URLS}. */
  readonly apiUrl: string;
  readonly apiKey: string;
  /** How long one attempt may take. */
  readonly timeoutMs: number;
  /** Attempts of one call, the first included (a booking is always one). */
  readonly maxAttempts: number;
  /** The first retry waits this long; each next one twice as long. */
  readonly backoffMs: number;
  readonly circuit: CircuitBreakerSettings;
}

/** `unauthorized`: Zoom2u rejected the API key (401, 403); nothing was booked. */
export type Zoom2uCallFailure = 'unavailable' | 'refused' | 'unauthorized';
export type Zoom2uCallKind = 'quote' | 'book' | 'cancel' | 'status';
export type Zoom2uAnswer = Result<
  { readonly status: number; readonly body: unknown },
  Zoom2uCallFailure
>;

type Attempt =
  { kind: 'answer'; status: number; body: unknown } | { kind: 'fault'; throttled: boolean };

/**
 * The HTTP client of the Zoom2u API: JSON over HTTPS with the account API key as a bearer token.
 * Each attempt has a timeout; a 5xx, a timeout or a network fault is retried (a 429 too, except
 * on a quote) with exponential backoff, a 4xx never is. A BOOKING IS NEVER RETRIED: Zoom2u
 * documents no idempotency key (`PurchaseOrderNumber` is a label, not a dedup key), so a repeat
 * after a lost answer could book a second courier; the caller gets "unavailable" and decides.
 * A 401 or 403 is a key problem: "unauthorized", never counted on the circuit. A circuit breaker
 * per Market and kind of call stops calls while Zoom2u is down. The key and Zoom2u's answer
 * bodies never reach a log or an error: a failure is a code.
 */
export class Zoom2uHttpClient {
  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly fetchFn: Zoom2uFetch = (url, init) => fetch(url, init),
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** `path` is relative to the delivery prefix, e.g. `quote` or `cancel/T2026...`. */
  post(
    endpoint: Zoom2uEndpoint,
    path: string,
    body: unknown,
    call: 'book' | 'cancel' | 'quote',
  ): Promise<Zoom2uAnswer> {
    // A cancel takes no body ("left blank"); a quote and a booking take JSON.
    return this.call(
      endpoint,
      'POST',
      path,
      call === 'cancel' ? undefined : JSON.stringify(body),
      call,
    );
  }

  get(endpoint: Zoom2uEndpoint, path: string): Promise<Zoom2uAnswer> {
    return this.call(endpoint, 'GET', path, undefined, 'status');
  }

  private async call(
    endpoint: Zoom2uEndpoint,
    method: 'GET' | 'POST',
    path: string,
    payload: string | undefined,
    call: Zoom2uCallKind,
  ): Promise<Zoom2uAnswer> {
    const key = `${endpoint.marketId}|${call}`;
    if (!this.breaker.allow(key)) return err('unavailable');
    const url = `${endpoint.apiUrl.replace(/\/+$/, '')}${ZOOM2U_API_PREFIX}/${path}`;
    const maxAttempts = call === 'book' ? 1 : endpoint.maxAttempts;
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.once(endpoint, method, url, payload);
      if (answer.kind === 'answer') {
        if (answer.status === 401 || answer.status === 403) {
          // The key is wrong, revoked or not allowed: an operations problem, not a fault of
          // Zoom2u. It must not open the circuit (that would turn "unauthorized" into
          // "unavailable"), and a half-open trial is settled. Nothing was booked.
          this.breaker.succeeded(key);
          return err('unauthorized');
        }
        // A 4xx is Zoom2u's decision about the request, not a fault of Zoom2u.
        this.breaker.succeeded(key);
        return answer.status < 400
          ? ok({ status: answer.status, body: answer.body })
          : err('refused');
      }
      // A quote waits on a customer at checkout: a 429 falls back at once.
      if (attempt >= maxAttempts || (answer.throttled && call === 'quote')) {
        this.breaker.failed(key, endpoint.circuit);
        return err('unavailable');
      }
      await this.sleep(endpoint.backoffMs * 2 ** (attempt - 1));
    }
  }

  private async once(
    endpoint: Zoom2uEndpoint,
    method: 'GET' | 'POST',
    url: string,
    payload: string | undefined,
  ): Promise<Attempt> {
    try {
      const response = await this.fetchFn(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${endpoint.apiKey}`,
          'content-type': 'application/json',
        },
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
        redirect: 'error',
      });
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
