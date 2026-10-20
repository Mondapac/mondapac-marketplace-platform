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
  /** Refused, unreachable, too slow, not JSON, or the host is not listed. */
  | { readonly kind: 'failed' };

interface RequestHeaders {
  get(name: string): string | null;
}

const log = (line: Readonly<Record<string, unknown>>): void => {
  console.log(JSON.stringify(line));
};

/** {@link apiGet} with its inputs given, for tests. */
export async function apiGetWith<T>(
  config: StorefrontApiConfig | null,
  incoming: RequestHeaders,
  path: string,
  nowMilliseconds: () => number = Date.now,
): Promise<ApiRead<T>> {
  if (config === null) return { kind: 'off' };
  const host = storefrontHostFor(config, incoming.get('host'));
  if (host === undefined) {
    log({ msg: 'storefront.api-read-unknown-host', path });
    return { kind: 'failed' };
  }
  try {
    const upstream = new Headers({ accept: 'application/json', 'x-market-id': host.marketId });
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
    const response = await fetch(`${config.apiBaseUrl}/${path}`, {
      headers: upstream,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(READ_TIMEOUT_MS),
    });
    if (!response.ok) {
      log({ msg: 'storefront.api-read-refused', path, status: response.status });
      return { kind: 'failed' };
    }
    return { kind: 'ok', body: (await response.json()) as T };
  } catch (error) {
    // A missing address means the request did not come through server.mjs; never sent unsigned.
    const reason =
      error instanceof MissingClientAddressError
        ? 'client-address-missing'
        : error instanceof Error
          ? error.name
          : 'unknown';
    log({ msg: 'storefront.api-read-failed', path, error: reason });
    return { kind: 'failed' };
  }
}

/**
 * A GET of a public API route (`path` without the leading slash, query included) for the
 * current request. Answers `off` while API_BASE_URL is empty, so the caller keeps its sample.
 */
export async function apiGet<T>(path: string): Promise<ApiRead<T>> {
  const config = storefrontApiConfig();
  if (config === null) return { kind: 'off' };
  const incoming = await headers();
  return apiGetWith<T>(config, incoming, path);
}
