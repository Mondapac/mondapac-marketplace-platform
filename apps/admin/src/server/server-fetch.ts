import 'server-only';
import { headers } from 'next/headers';
import { INTERNAL_ADDRESS_HEADER, MissingClientAddressError } from '@mondapac/panel-server';
import { panelConfig } from './config.ts';
import { panelHostFor, upstreamHeaders } from './bff.ts';

export type ServerGet<T> =
  | { readonly kind: 'ok'; readonly body: T }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'forbidden' }
  /** `details` is the `details` object of the API's refusal, when it sent one. */
  | { readonly kind: 'not-found'; readonly details?: Readonly<Record<string, unknown>> }
  | { readonly kind: 'conflict' }
  | { readonly kind: 'unavailable' };

/**
 * A GET from a server component to the API, with the same mapping and header code as the relay
 * (ADR-0034 decision 4): the browser's cookie, the Market of the host and the signed client
 * address. It never sets a cookie: a rejected session is cleared through `/session-ended`.
 */
export async function serverGet<T>(
  path: string,
  options: { readonly anonymous?: boolean } = {},
): Promise<ServerGet<T>> {
  const config = panelConfig();
  const incoming = await headers();
  const host = panelHostFor(config, incoming.get('host'));
  if (host === undefined) return { kind: 'unavailable' };
  const request = new Request(`${host.origin}/`, {
    headers: {
      // An anonymous read (a public route) never carries the visitor's session cookie.
      cookie: options.anonymous === true ? '' : (incoming.get('cookie') ?? ''),
      accept: 'application/json',
      // Set by server.mjs on every request; the signer reads only this name (ADR-0037).
      ...(incoming.has(INTERNAL_ADDRESS_HEADER)
        ? { [INTERNAL_ADDRESS_HEADER]: incoming.get(INTERNAL_ADDRESS_HEADER) ?? '' }
        : {}),
    },
  });
  try {
    const response = await fetch(`${config.apiBaseUrl}/${path}`, {
      headers: upstreamHeaders(request, host, config),
      cache: 'no-store',
      redirect: 'manual',
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (response.status === 403) return { kind: 'forbidden' };
    if (response.status === 404) {
      const refusal = (await response.json().catch((): unknown => null)) as {
        details?: Record<string, unknown>;
      } | null;
      return refusal?.details === undefined
        ? { kind: 'not-found' }
        : { kind: 'not-found', details: refusal.details };
    }
    if (response.status === 409) return { kind: 'conflict' };
    if (!response.ok) return { kind: 'unavailable' };
    return { kind: 'ok', body: (await response.json()) as T };
  } catch (error) {
    if (error instanceof MissingClientAddressError) {
      console.log(JSON.stringify({ msg: 'panel.server-get.client-address-missing' }));
    }
    return { kind: 'unavailable' };
  }
}
