import 'server-only';
import { headers } from 'next/headers';
import {
  CLIENT_ADDRESS_HEADER,
  MissingClientAddressError,
  signForRequest,
} from '@mondapac/panel-server';
import type { ApiRead } from './api.ts';
import { storefrontApiConfig, storefrontHostFor, type StorefrontApiConfig } from './config.ts';
import { RELAY_TIMEOUT_MS, upstreamCookie } from './session-relay.ts';

// A page's read of the buyer's own session or cart, from a server component (storefront session
// design 2). It sends the host Market's session and guest-cart cookies and nothing else, and it
// never sets a cookie: a page cannot answer Set-Cookie, so a renewed or cleared cookie reaches the
// browser only through the relay (app/api/[...path]). An ended session reads as a guest.

/** The only paths a page reads with the buyer's cookies. */
export type SessionReadPath =
  'cart' | 'identity/customer/session' | 'orders?limit=100' | `orders/${string}`;

interface RequestHeaders {
  get(name: string): string | null;
}

const log = (line: Readonly<Record<string, unknown>>): void => {
  console.log(JSON.stringify(line));
};

/** {@link sessionGet} with its inputs given, for tests. */
export async function sessionGetWith<T>(
  config: StorefrontApiConfig | null,
  incoming: RequestHeaders,
  cookieHeader: string | null,
  path: SessionReadPath,
  nowMilliseconds: () => number = Date.now,
): Promise<ApiRead<T>> {
  if (config === null) return { kind: 'off' };
  const host = storefrontHostFor(config, incoming.get('host'));
  if (host === undefined) {
    log({ msg: 'storefront.session-read-unknown-host', path });
    return { kind: 'failed' };
  }
  try {
    const upstream = new Headers({ accept: 'application/json', 'x-market-id': host.marketId });
    const cookie = upstreamCookie(cookieHeader, host.marketId);
    if (cookie !== null) upstream.set('cookie', cookie);
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
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    if (!response.ok) {
      // 401 is an ended or absent session: the page shows the guest state.
      if (response.status !== 401) {
        log({ msg: 'storefront.session-read-refused', path, status: response.status });
      }
      return { kind: 'failed', status: response.status };
    }
    return { kind: 'ok', body: (await response.json()) as T };
  } catch (error) {
    const reason =
      error instanceof MissingClientAddressError
        ? 'client-address-missing'
        : error instanceof Error
          ? error.name
          : 'unknown';
    log({ msg: 'storefront.session-read-failed', path, error: reason });
    return { kind: 'failed' };
  }
}

/** A GET of the buyer's session or cart for the current request. `off` while the API is off. */
export async function sessionGet<T>(path: SessionReadPath): Promise<ApiRead<T>> {
  const config = storefrontApiConfig();
  if (config === null) return { kind: 'off' };
  const incoming = await headers();
  return sessionGetWith<T>(config, incoming, incoming.get('cookie'), path);
}
