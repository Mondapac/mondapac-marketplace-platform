import { createHmac } from 'node:crypto';
import { err, ok } from '@mondapac/shared-kernel';
import type { Clock, Result } from '@mondapac/shared-kernel';
import type { CircuitBreaker, CircuitBreakerSettings } from './circuit-breaker';
import { boundedJson, type DriveFetch, type Sleep } from './drive-http-client';

/** `fetch`, narrowed as the Drive client's is plus PUT (cancel), so tests can pass a fake. */
export type DoorDashFetch = (
  url: string,
  init: Omit<Parameters<DriveFetch>[1], 'method'> & { method: 'GET' | 'POST' | 'PUT' },
) => ReturnType<DriveFetch>;

/** DoorDash's API host (developer.doordash.com); fixed, never from configuration. */
export const DOORDASH_API_URL = 'https://openapi.doordash.com';

/** A token lives this long (DoorDash allows up to 1800 s) and is replaced shortly before it ends. */
export const JWT_LIFETIME_SECONDS = 300;
export const JWT_EARLY_REFRESH_MS = 60_000;

/** One Market's DoorDash Drive connection. Holds the signing secret: never logged or put in an error. */
export interface DoorDashDriveEndpoint {
  readonly marketId: string;
  readonly apiUrl: string;
  readonly developerId: string;
  readonly keyId: string;
  /** The key's secret, base64url; decoded to bytes it is the HMAC key. */
  readonly signingSecret: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly backoffMs: number;
  readonly circuit: CircuitBreakerSettings;
}

/**
 * `unauthorized`: DoorDash rejected the credentials (401, 403); nothing was booked. `conflict`:
 * a 409, DoorDash already holds a delivery or quote with this `external_delivery_id`. `not-sent`:
 * nothing reached DoorDash (an open circuit). `unavailable`: the request may have left.
 */
export type DoorDashCallFailure =
  'unavailable' | 'refused' | 'unauthorized' | 'not-sent' | 'conflict';
export type DoorDashCallKind = 'quote' | 'book' | 'cancel' | 'status';

const b64url = (value: string | Buffer): string => Buffer.from(value).toString('base64url');

/**
 * DoorDash's per-request JWT: HS256, header `dd-ver: DD-JWT-V1`, claims `aud: doordash`, the
 * developer id (`iss`), the key id (`kid`), `iat` and `exp` (at most 1800 s later). Built from
 * the given instant (the injected Clock's), signed with the base64url-decoded secret.
 */
export function buildDoorDashJwt(
  credentials: Pick<DoorDashDriveEndpoint, 'developerId' | 'keyId' | 'signingSecret'>,
  nowSeconds: number,
): { readonly jwt: string; readonly expiresAtSeconds: number } {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT', 'dd-ver': 'DD-JWT-V1' }));
  const expiresAtSeconds = nowSeconds + JWT_LIFETIME_SECONDS;
  const claims = b64url(
    JSON.stringify({
      aud: 'doordash',
      iss: credentials.developerId,
      kid: credentials.keyId,
      iat: nowSeconds,
      exp: expiresAtSeconds,
    }),
  );
  const signature = createHmac('sha256', Buffer.from(credentials.signingSecret, 'base64url'))
    .update(`${header}.${claims}`)
    .digest('base64url');
  return { jwt: `${header}.${claims}.${signature}`, expiresAtSeconds };
}

interface CachedJwt {
  readonly jwt: string;
  /** Epoch milliseconds from which the token is no longer used. */
  readonly usableUntil: number;
}

type Attempt =
  { kind: 'answer'; status: number; body: unknown } | { kind: 'fault'; throttled: boolean };

/**
 * The HTTP client of the DoorDash Drive v2 API: JSON over HTTPS, each call carrying a signed JWT
 * as a bearer token (kept per Market until a minute before it expires; there is no token
 * endpoint). Each attempt has a timeout; a 5xx, a timeout or a network fault is retried (a 429
 * too, except on a quote) with exponential backoff, a 4xx never is. A booking may be retried:
 * the `external_delivery_id` is ours, so a repeat that finds the first one answers 409 and the
 * adapter reads that delivery back. A circuit breaker per Market and kind of call stops calls
 * while DoorDash is down. The secret, the token and DoorDash's answer bodies never reach a log
 * or an error: a failure is a code.
 */
export class DoorDashDriveHttpClient {
  readonly #tokens = new Map<string, CachedJwt>();

  constructor(
    private readonly breaker: CircuitBreaker,
    private readonly clock: Clock,
    private readonly fetchFn: DoorDashFetch = (url, init) => fetch(url, init),
    private readonly sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  ) {}

  /** `path` is relative to `/drive/v2/`, e.g. `deliveries/<id>/cancel`. */
  send(
    endpoint: DoorDashDriveEndpoint,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    body: unknown,
    call: DoorDashCallKind,
  ): Promise<Result<{ readonly status: number; readonly body: unknown }, DoorDashCallFailure>> {
    return this.call(
      endpoint,
      method,
      path,
      body === undefined ? undefined : JSON.stringify(body),
      call,
    );
  }

  private async call(
    endpoint: DoorDashDriveEndpoint,
    method: 'GET' | 'POST' | 'PUT',
    path: string,
    payload: string | undefined,
    call: DoorDashCallKind,
  ): Promise<Result<{ readonly status: number; readonly body: unknown }, DoorDashCallFailure>> {
    const key = `${endpoint.marketId}|${endpoint.developerId}|${call}`;
    if (!this.breaker.allow(key)) return err('not-sent');
    const url = `${endpoint.apiUrl.replace(/\/+$/, '')}/drive/v2/${path}`;
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.once(endpoint, method, url, payload, {
        accept: 'application/json',
        authorization: `Bearer ${this.token(endpoint)}`,
        ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
      });
      if (answer.kind === 'answer') {
        // A 4xx is DoorDash's decision about the request, not a fault of DoorDash.
        this.breaker.succeeded(key);
        if (answer.status === 401 || answer.status === 403) return err('unauthorized');
        if (answer.status === 409) return err('conflict');
        return answer.status < 400
          ? ok({ status: answer.status, body: answer.body })
          : err('refused');
      }
      // A 429 on a quote falls back at once (the router can try another fleet) instead of adding
      // retries while DoorDash sheds load.
      if (attempt >= endpoint.maxAttempts || (answer.throttled && call === 'quote')) {
        this.breaker.failed(key, endpoint.circuit);
        return err('unavailable');
      }
      await this.sleep(endpoint.backoffMs * 2 ** (attempt - 1));
    }
  }

  /** The cached JWT of the Market's key, or a new one signed now. */
  private token(endpoint: DoorDashDriveEndpoint): string {
    const cacheKey = `${endpoint.marketId}|${endpoint.developerId}|${endpoint.keyId}`;
    const nowMs = this.clock.now().epochMilliseconds;
    const cached = this.#tokens.get(cacheKey);
    if (cached !== undefined && nowMs < cached.usableUntil) return cached.jwt;
    const built = buildDoorDashJwt(endpoint, Math.floor(nowMs / 1000));
    this.#tokens.set(cacheKey, {
      jwt: built.jwt,
      usableUntil: built.expiresAtSeconds * 1000 - JWT_EARLY_REFRESH_MS,
    });
    return built.jwt;
  }

  private async once(
    endpoint: DoorDashDriveEndpoint,
    method: 'GET' | 'POST' | 'PUT',
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
