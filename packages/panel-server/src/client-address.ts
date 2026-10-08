// The BFF side of ADR-0037: signs the browser's address so the API accepts it from a pinned BFF
// network. Pure functions, no `server-only` import, so tests run without the React server
// condition; the package entry (`index.ts`) is the server-only one.
import { createHmac } from 'node:crypto';
import { isIP } from 'node:net';

export const CLIENT_ADDRESS_HEADER = 'x-client-address';

const KEY_ID = /^[a-z0-9-]{1,32}$/;
const MARKET_ID = /^[A-Z]{2}$/;
const MIN_SECRET_BYTES = 32;

export interface ClientAddressKey {
  readonly keyId: string;
  readonly secret: Buffer;
}

/**
 * Reads this BFF's own key from server environment variables (never `NEXT_PUBLIC_*`). Both
 * unset: null (the feature is off on this side). One set without the other, a malformed keyId or
 * a short or non-base64 secret throws, so start-up fails; the secret is never printed.
 */
export function parseClientAddressKey(
  env: Readonly<Record<string, string | undefined>>,
): ClientAddressKey | null {
  const keyId = env['CLIENT_ADDRESS_KEY_ID']?.trim() ?? '';
  const encoded = env['CLIENT_ADDRESS_KEY']?.trim() ?? '';
  if (keyId === '' && encoded === '') return null;
  if (keyId === '' || encoded === '') {
    throw new Error('CLIENT_ADDRESS_KEY_ID and CLIENT_ADDRESS_KEY must be set together');
  }
  if (!KEY_ID.test(keyId)) throw new Error('CLIENT_ADDRESS_KEY_ID must match [a-z0-9-]{1,32}');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length % 4 !== 0) {
    throw new Error('CLIENT_ADDRESS_KEY must be standard base64');
  }
  const secret = Buffer.from(encoded, 'base64');
  if (secret.length < MIN_SECRET_BYTES) {
    throw new Error(`CLIENT_ADDRESS_KEY must decode to at least ${MIN_SECRET_BYTES} bytes`);
  }
  return { keyId, secret };
}

export interface SignInput {
  readonly key: ClientAddressKey;
  /** The Market the request is relayed for, exactly as sent in `x-market-id`. */
  readonly marketId: string;
  /** Exactly one IPv4 or IPv6 address in text form. */
  readonly address: string;
  /** The signing instant in whole Unix seconds. */
  readonly nowSeconds: number;
}

/** The value of `x-client-address`: `v1;k=<keyId>;t=<seconds>;a=<address>;s=<signature>`. */
export function signClientAddress({ key, marketId, address, nowSeconds }: SignInput): string {
  if (!MARKET_ID.test(marketId)) throw new Error('marketId must be a Market code');
  // `isIP` accepts a zone index (`fe80::1%eth0`); ADR-0037 decision 2 refuses it.
  if (isIP(address) === 0 || address.includes('%')) {
    throw new Error('address must be one IP address');
  }
  if (!Number.isInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error('nowSeconds must be a whole number of seconds');
  }
  const message = `v1\n${key.keyId}\n${nowSeconds}\n${address}\n${marketId}`;
  const signature = createHmac('sha256', key.secret).update(message, 'utf8').digest('base64url');
  return `v1;k=${key.keyId};t=${nowSeconds};a=${address};s=${signature}`;
}
