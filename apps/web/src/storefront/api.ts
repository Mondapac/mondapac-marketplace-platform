import 'server-only';
import { headers } from 'next/headers';
import {
  CLIENT_ADDRESS_HEADER,
  MissingClientAddressError,
  signForRequest,
} from '@mondapac/panel-server';
import { storefrontApiConfig, storefrontHostFor, type StorefrontApiConfig } from './config.ts';

// The buyer site's one way to read the API: a GET of a public route from a server component. It
// sends the Market of the host the buyer came to (`x-market-id`) and, with a signing key, the
// buyer's address as server.mjs saw it (`x-client-address`, ADR-0037), so the API rate-limits
// each buyer rather than the whole site. No cookie and no session go with it: these routes are
// anonymous. Reads that need the buyer's session come with their own package.

/** How long a read may take before the page renders without it. */
export const READ_TIMEOUT_MS = 3000;

export type ApiRead<T> =
  /** API_BASE_URL is empty: the caller answers sample data. */
  | { readonly kind: 'off' }
  | { readonly kind: 'ok'; readonly body: T }
  /**
   * Refused, unreachable, too slow, not JSON, or the host is not listed. When the API refused,
   * `status` is its status and `code` its error code, if the body had one: a caller tells "no
   * such thing" from a fault by the module's own code, never by a bare 404 (a missing route).
   */
  | { readonly kind: 'failed'; readonly status?: number; readonly code?: string };

interface RequestHeaders {
  get(name: string): string | null;
}

const log = (line: Readonly<Record<string, unknown>>): void => {
  console.log(JSON.stringify(line));
};

/** The route without its query, for logs: a query can hold what a buyer typed. */
const routeOf = (path: string): string => path.split('?')[0] ?? '';

/**
 * The URL of a path relative to the API root, or null when the path could leave the route meant:
 * a leading slash, a backslash, a fragment, white space, or a dot segment (plain or encoded) that
 * the URL parser would fold away. Callers still encode every value they put in a path.
 */
function urlOf(origin: string, path: string): string | null {
  if (path.startsWith('/') || /[#\\\s]/u.test(path)) return null;
  const url = new URL(`${origin}/${path}`);
  if (url.origin !== origin || url.pathname !== `/${routeOf(path)}`) return null;
  return url.href;
}

/** The `code` of an API error body, when it is JSON with a short string code. */
async function errorCodeOf(response: Response): Promise<string | undefined> {
  try {
    const body: unknown = await response.json();
    const code =
      typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
    return typeof code === 'string' && /^[a-z0-9.-]{1,64}$/u.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** What a read does with an answer that is ok: parse it into the caller's type. */
type ReadBody<T> = (response: Response) => Promise<T>;

/** One GET of a public API route; {@link apiGetWith} and {@link apiGetBytesWith} differ in the body. */
async function readWith<T>(
  config: StorefrontApiConfig | null,
  incoming: RequestHeaders,
  path: string,
  nowMilliseconds: () => number,
  accept: string,
  readBody: ReadBody<T>,
): Promise<ApiRead<T>> {
  if (config === null) return { kind: 'off' };
  const url = urlOf(config.apiBaseUrl, path);
  if (url === null) {
    log({ msg: 'storefront.api-read-bad-path' });
    return { kind: 'failed' };
  }
  const host = storefrontHostFor(config, incoming.get('host'));
  if (host === undefined) {
    log({ msg: 'storefront.api-read-unknown-host', path: routeOf(path) });
    return { kind: 'failed' };
  }
  try {
    const upstream = new Headers({ accept, 'x-market-id': host.marketId });
    if (config.clientAddressKey !== null) {
      upstream.set(
        CLIENT_ADDRESS_HEADER,
        signForRequest({
          key: config.clientAddressKey,
          marketId: host.marketId,
          headers: incoming,
          nowSeconds: Math.floor(nowMilliseconds() / 1000),
        }),
      );
    }
    const response = await fetch(url, {
      headers: upstream,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      log({ msg: 'storefront.api-read-refused', path: routeOf(path), status: response.status });
      const code = await errorCodeOf(response);
      return code === undefined
        ? { kind: 'failed', status: response.status }
        : { kind: 'failed', status: response.status, code };
    }
    return { kind: 'ok', body: await readBody(response) };
  } catch (error) {
    // A missing address means the request did not come through server.mjs; never sent unsigned.
    const reason =
      error instanceof MissingClientAddressError
        ? 'client-address-missing'
        : error instanceof Error
          ? error.name
          : 'unknown';
    log({ msg: 'storefront.api-read-failed', path: routeOf(path), error: reason });
    return { kind: 'failed' };
  }
}

/** {@link apiGet} with its inputs given, for tests. */
export async function apiGetWith<T>(
  config: StorefrontApiConfig | null,
  incoming: RequestHeaders,
  path: string,
  nowMilliseconds: () => number = Date.now,
): Promise<ApiRead<T>> {
  return readWith(config, incoming, path, nowMilliseconds, 'application/json', async (response) => {
    return (await response.json()) as T;
  });
}

/** The most bytes of a picture read from the API: a store image is a rendition of a few hundred KB. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** A picture the API answered: its bytes and the type it declared. */
export interface ApiBytes {
  readonly bytes: Uint8Array;
  readonly contentType: string;
}

/** {@link apiGetBytes} with its inputs given, for tests. */
export async function apiGetBytesWith(
  config: StorefrontApiConfig | null,
  incoming: RequestHeaders,
  path: string,
  nowMilliseconds: () => number = Date.now,
): Promise<ApiRead<ApiBytes>> {
  return readWith(config, incoming, path, nowMilliseconds, 'image/jpeg', async (response) => {
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_IMAGE_BYTES) throw new RangeError('the picture is too large');
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length > MAX_IMAGE_BYTES) throw new RangeError('the picture is too large');
    return { bytes, contentType: response.headers.get('content-type') ?? '' };
  });
}

/**
 * A GET of a public API route (`path` without the leading slash, query included, every value
 * encoded with `encodeURIComponent` by the caller) for the
 * current request. Answers `off` while API_BASE_URL is empty, so the caller keeps its sample.
 */
export async function apiGet<T>(path: string): Promise<ApiRead<T>> {
  const config = storefrontApiConfig();
  if (config === null) return { kind: 'off' };
  const incoming = await headers();
  return apiGetWith<T>(config, incoming, path);
}

/** A GET of a public API route that answers a picture, for the current request (see {@link apiGet}). */
export async function apiGetBytes(path: string): Promise<ApiRead<ApiBytes>> {
  const config = storefrontApiConfig();
  if (config === null) return { kind: 'off' };
  const incoming = await headers();
  return apiGetBytesWith(config, incoming, path);
}
