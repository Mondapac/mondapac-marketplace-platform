import { err, ok } from '@mondapac/shared-kernel';
import type { Result } from '@mondapac/shared-kernel';
import type { CircuitBreaker, CircuitBreakerSettings } from './circuit-breaker';

/** `fetch`, narrowed to what the client uses, so tests can pass a fake. */
export type DriveFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
    redirect: 'error';
  },
) => Promise<{ readonly status: number; json(): Promise<unknown> }>;

/** Waits; injected so tests do not sleep. */
export type Sleep = (milliseconds: number) => Promise<void>;

export interface DriveEndpoint {
  /** The Drive API's base URL (https, or http for a loopback test server). */
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly marketId: string;
  /** How long one attempt may take. */
  readonly timeoutMs: number;
  /** Attempts of one call, the first included. */
  readonly maxAttempts: number;
  /** The first retry waits this long; each next one twice as long. */
  readonly backoffMs: number;
  readonly circuit: CircuitBreakerSettings;
}

export type DriveCallFailure = 'unavailable' | 'refused';

/**
 * The HTTP client of the Mondapac Drive API: JSON over HTTPS with the Market in `x-market-id`
 * and the merchant API key as a bearer token. Each attempt has a timeout; a 5xx, a timeout or a
 * network fault is retried with exponential backoff (every Drive call the marketplace makes is
 * idempotent), a 4xx never is. A circuit breaker per Market stops calls while Drive is down.
 * The key and Drive's answer bodies never reach a log or an error: a failure is a code.
 */
export class DriveHttpClient {
  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly fetchFn: DriveFetch = (url, init) => fetch(url, init),
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  async post(
    endpoint: DriveEndpoint,
    path: string,
    body: unknown,
  ): Promise<Result<{ readonly status: number; readonly body: unknown }, DriveCallFailure>> {
    const key = `${endpoint.marketId}|${endpoint.baseUrl}`;
    if (!this.breaker.allow(key)) return err('unavailable');
    const url = `${endpoint.baseUrl.replace(/\/+$/, '')}${path}`;
    const payload = JSON.stringify(body);
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.once(endpoint, url, payload);
      if (answer.kind === 'answer') {
        // A 4xx is Drive's decision about the request, not a fault of Drive.
        this.breaker.succeeded(key);
        return answer.status < 400
          ? ok({ status: answer.status, body: answer.body })
          : err('refused');
      }
      if (attempt >= endpoint.maxAttempts) {
        this.breaker.failed(key, endpoint.circuit);
        return err('unavailable');
      }
      await this.sleep(endpoint.backoffMs * 2 ** (attempt - 1));
    }
  }

  private async once(
    endpoint: DriveEndpoint,
    url: string,
    payload: string,
  ): Promise<{ kind: 'answer'; status: number; body: unknown } | { kind: 'fault' }> {
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${endpoint.apiKey}`,
          'x-market-id': endpoint.marketId,
        },
        body: payload,
        signal: AbortSignal.timeout(endpoint.timeoutMs),
        redirect: 'error',
      });
      if (response.status >= 500) return { kind: 'fault' };
      let body: unknown = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      return { kind: 'answer', status: response.status, body };
    } catch {
      return { kind: 'fault' };
    }
  }
}
