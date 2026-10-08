import 'server-only';
import { headers } from 'next/headers';
import { INTERNAL_ADDRESS_HEADER } from '@mondapac/panel-server';
import { panelConfig } from './config.ts';
import { panelHostFor, upstreamHeaders } from './bff.ts';

export interface SellerSession {
  readonly accountId: string;
  readonly sellerId: string;
  readonly permissionKeys: readonly string[];
  readonly sellerAccessState: 'pending' | 'approved' | 'rejected';
  readonly email: string;
  readonly displayName: string;
  readonly csrfToken: string;
}

export type SessionRead =
  | { readonly kind: 'signed-in'; readonly session: SellerSession }
  | { readonly kind: 'signed-out' }
  | { readonly kind: 'unavailable' };

/**
 * Reads the actor summary for the page being rendered, with the same mapping and header code as
 * the relay (ADR-0034 decision 4). It never sets a cookie: a rejected session is cleared through
 * the relay by `/session-ended`.
 */
export async function readSession(): Promise<SessionRead> {
  const config = panelConfig();
  const incoming = await headers();
  const host = panelHostFor(config, incoming.get('host'));
  if (host === undefined) return { kind: 'unavailable' };
  const request = new Request(`${host.origin}/`, {
    headers: {
      cookie: incoming.get('cookie') ?? '',
      accept: 'application/json',
      // Set by server.mjs on every request; the signer reads only this name (ADR-0037).
      ...(incoming.has(INTERNAL_ADDRESS_HEADER)
        ? { [INTERNAL_ADDRESS_HEADER]: incoming.get(INTERNAL_ADDRESS_HEADER) ?? '' }
        : {}),
    },
  });
  try {
    const response = await fetch(`${config.apiBaseUrl}/identity/seller/session`, {
      headers: upstreamHeaders(request, host, config),
      cache: 'no-store',
      redirect: 'manual',
    });
    if (response.status === 401) return { kind: 'signed-out' };
    if (!response.ok) return { kind: 'unavailable' };
    const body = (await response.json()) as SellerSession;
    return { kind: 'signed-in', session: body };
  } catch {
    return { kind: 'unavailable' };
  }
}
