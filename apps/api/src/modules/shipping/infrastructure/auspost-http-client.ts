import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { CircuitBreaker, CircuitBreakerSettings } from './circuit-breaker';
import { boundedJson, type DriveFetch, type Sleep } from './drive-http-client';

/** `fetch`, narrowed as the Drive client's is plus DELETE, so tests can pass a fake. */
export type AusPostFetch = (
  url: string,
  init: Omit<Parameters<DriveFetch>[1], 'method'> & { method: 'GET' | 'POST' | 'DELETE' },
) => ReturnType<DriveFetch>;

export type AusPostEnvironment = 'testbed' | 'production';

/**
 * Australia Post's Shipping and Tracking API hosts (developers.auspost.com.au); fixed, never from
 * configuration. The testbed host is the documented one for integration work: shipments made
 * there are never lodged or invoiced.
 */
export const AUSPOST_API_URLS: Readonly<Record<AusPostEnvironment, string>> = Object.freeze({
  production: 'https://digitalapi.auspost.com.au',
  testbed: 'https://digitalapi.auspost.com.au/test',
});

/** The path every Shipping and Tracking call lives under. */
export const AUSPOST_API_PREFIX = '/shipping/v1';

/** One Market's Australia Post connection. Holds the credentials: never logged or in an error. */
export interface AusPostEndpoint {
  readonly marketId: string;
  /** The API host, one of {@link AUSPOST_API_URLS}. */
  readonly apiUrl: string;
  readonly apiKey: string;
  readonly apiPassword: string;
  /** Sent as the `Account-Number` header. */
  readonly accountNumber: string;
  /** How long one attempt may take. */
  readonly timeoutMs: number;
  /** Attempts of one call, the first included (a create is always one). */
  readonly maxAttempts: number;
  /** The first retry waits this long; each next one twice as long. */
  readonly backoffMs: number;
  readonly circuit: CircuitBreakerSettings;
}

/** `unauthorized`: Australia Post rejected the credentials (401, 403); nothing was created. */
export type AusPostCallFailure = 'unavailable' | 'refused' | 'unauthorized';
export type AusPostCallKind = 'quote' | 'book' | 'cancel' | 'status';
export type AusPostAnswer = Result<
  { readonly status: number; readonly body: unknown },
  AusPostCallFailure
>;

type Attempt =
  { kind: 'answer'; status: number; body: unknown } | { kind: 'fault'; throttled: boolean };

/**
 * The HTTP client of the Australia Post Shipping and Tracking API: JSON over HTTPS with HTTP
 * Basic auth (API key and password) and the `Account-Number` header. Each attempt has a timeout;
 * a 5xx, a timeout or a network fault is retried (a 429 too, except on a quote) with exponential
 * backoff, a 4xx never is. A SHIPMENT IS NEVER CREATED TWICE: the API documents no idempotency
 * key (a sender reference is a label, not a dedup key), so a repeat after a lost answer could
 * create a second shipment; the caller gets "unavailable" and decides. A 401 or 403 is a
 * credential problem: "unauthorized", never counted on the circuit. A circuit breaker per
 * Market and kind of call stops calls while the API is down. The credentials and the answer
 * bodies never reach a log or an error: a failure is a code.
 */
export class AusPostHttpClient {
  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly fetchFn: AusPostFetch = (url, init) => fetch(url, init),
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** `path` is relative to the prefix, e.g. `prices/items` or `shipments`. */
  post(
    endpoint: AusPostEndpoint,
    path: string,
    body: unknown,
    call: 'book' | 'quote',
  ): Promise<AusPostAnswer> {
    return this.call(endpoint, 'POST', path, JSON.stringify(body), call);
  }

  get(endpoint: AusPostEndpoint, path: string): Promise<AusPostAnswer> {
    return this.call(endpoint, 'GET', path, undefined, 'status');
  }

  delete(endpoint: AusPostEndpoint, path: string): Promise<AusPostAnswer> {
    return this.call(endpoint, 'DELETE', path, undefined, 'cancel');
  }

  private async call(
    endpoint: AusPostEndpoint,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    payload: string | undefined,
    call: AusPostCallKind,
  ): Promise<AusPostAnswer> {
    const key = `${endpoint.marketId}|${call}`;
    if (!this.breaker.allow(key)) return err('unavailable');
    const url = `${endpoint.apiUrl.replace(/\/+$/, '')}${AUSPOST_API_PREFIX}/${path}`;
    const maxAttempts = call === 'book' ? 1 : endpoint.maxAttempts;
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.once(endpoint, method, url, payload);
      if (answer.kind === 'answer') {
        if (answer.status === 401 || answer.status === 403) {
          // The credentials are wrong, revoked or not allowed: an operations problem, not a fault
          // of Australia Post. It must not open the circuit (that would turn "unauthorized" into
          // "unavailable"), and a half-open trial is settled. Nothing was created.
          this.breaker.succeeded(key);
          return err('unauthorized');
        }
        // A 4xx is the API's decision about the request, not a fault of the API.
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
    endpoint: AusPostEndpoint,
    method: 'GET' | 'POST' | 'DELETE',
    url: string,
    payload: string | undefined,
  ): Promise<Attempt> {
    try {
      const credentials = Buffer.from(`${endpoint.apiKey}:${endpoint.apiPassword}`).toString(
        'base64',
      );
      const response = await this.fetchFn(url, {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Basic ${credentials}`,
          'account-number': endpoint.accountNumber,
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
