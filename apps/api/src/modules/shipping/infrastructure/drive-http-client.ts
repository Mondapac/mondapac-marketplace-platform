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
) => Promise<{ readonly status: number; readonly body: ReadableStream<Uint8Array> | null }>;

/**
 * The largest answer body read (Hassan, SHP-02/03): Drive's answers are a few hundred bytes; a
 * larger one is not read whole into memory and counts as no answer.
 */
export const MAX_ANSWER_BYTES = 64 * 1024;

/** The body as JSON, or null when it is empty, not JSON or larger than the cap. */
async function boundedJson(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (body === null) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ANSWER_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

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

/** `unauthorized`: a 401 or 403, the key is missing or wrong (nothing was done). */
export type DriveCallFailure = 'unavailable' | 'refused' | 'unauthorized';

/**
 * The HTTP client of the Mondapac Drive API: JSON over HTTPS with the Market in `x-market-id`
 * and the merchant API key as a bearer token. Each attempt has a timeout; a 5xx, a timeout or a network
 * fault is retried (a 429 too, except on a quote) with exponential backoff (every Drive call the marketplace makes is
 * idempotent), a 4xx never is. A circuit breaker per Market stops calls while Drive is down.
 * The key and Drive's answer bodies never reach a log or an error: a failure is a code.
 */
export class DriveHttpClient {
  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly fetchFn: DriveFetch = (url, init) => fetch(url, init),
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /**
   * `call` names the kind of call (`book`, `cancel`, `quote`): each has its own circuit, so
   * failing quotes at checkout never stop the bookings of paid orders (Hassan, PR 1 follow-up).
   */
  post(
    endpoint: DriveEndpoint,
    path: string,
    body: unknown,
    call: 'book' | 'cancel' | 'quote',
  ): Promise<Result<{ readonly status: number; readonly body: unknown }, DriveCallFailure>> {
    return this.send(endpoint, 'POST', path, body, call);
  }

  /** A read (`status`): no body, its own circuit, retried like a booking. */
  get(
    endpoint: DriveEndpoint,
    path: string,
  ): Promise<Result<{ readonly status: number; readonly body: unknown }, DriveCallFailure>> {
    return this.send(endpoint, 'GET', path, undefined, 'status');
  }

  private async send(
    endpoint: DriveEndpoint,
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    call: 'book' | 'cancel' | 'quote' | 'status',
  ): Promise<Result<{ readonly status: number; readonly body: unknown }, DriveCallFailure>> {
    const key = `${endpoint.marketId}|${endpoint.baseUrl}|${call}`;
    if (!this.breaker.allow(key)) return err('unavailable');
    const url = `${endpoint.baseUrl.replace(/\/+$/, '')}${path}`;
    const payload = body === undefined ? undefined : JSON.stringify(body);
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.once(endpoint, method, url, payload);
      if (answer.kind === 'answer') {
        // A 4xx is Drive's decision about the request, not a fault of Drive.
        this.breaker.succeeded(key);
        if (answer.status < 400) return ok({ status: answer.status, body: answer.body });
        return err(answer.status === 401 || answer.status === 403 ? 'unauthorized' : 'refused');
      }
      // A quote waits on a customer at checkout: a 429 falls back to the flat fee at once
      // instead of adding retries while Drive sheds load (Hassan, SHP-02/03 re-check).
      if (attempt >= endpoint.maxAttempts || (answer.throttled && call === 'quote')) {
        this.breaker.failed(key, endpoint.circuit);
        return err('unavailable');
      }
      await this.sleep(endpoint.backoffMs * 2 ** (attempt - 1));
    }
  }

  private async once(
    endpoint: DriveEndpoint,
    method: 'GET' | 'POST',
    url: string,
    payload: string | undefined,
  ): Promise<
    { kind: 'answer'; status: number; body: unknown } | { kind: 'fault'; throttled: boolean }
  > {
    try {
      const response = await this.fetchFn(url, {
        method,
        headers: {
          accept: 'application/json',
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
          authorization: `Bearer ${endpoint.apiKey}`,
          'x-market-id': endpoint.marketId,
        },
        ...(payload === undefined ? {} : { body: payload }),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
        redirect: 'error',
      });
      // A 429 is Drive shedding load, not a judgement of the request: it counts towards the
      // circuit like a 5xx and is retried on bookings and cancels (Hassan, SHP-02/03).
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
