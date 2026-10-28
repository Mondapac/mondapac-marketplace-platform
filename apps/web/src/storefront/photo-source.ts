import 'server-only';
import { headers } from 'next/headers';
import { storefrontApiConfig, storefrontHostFor } from './config.ts';
import { photoUrlBuilder, type PhotoUrl } from './photos.ts';

/**
 * The photo URL builder of this request: the configured photo origin and the Market of the host
 * the buyer came to. Null (no photos, illustrations stay) while the API is off, no photo origin is
 * set, or the host is not listed.
 */
export async function photoUrls(): Promise<PhotoUrl | null> {
  const config = storefrontApiConfig();
  if (config === null || config.imageOrigin === null) return null;
  const host = storefrontHostFor(config, (await headers()).get('host'));
  return photoUrlBuilder(config.imageOrigin, host?.marketId ?? null);
}

/**
 * The photo origin and Market of this request, for the browser to build photo URLs of the real
 * cart (the same builder, `photoUrlBuilder`). Null when photos are off.
 */
export async function photoBase(): Promise<{ origin: string; marketId: string } | null> {
  const config = storefrontApiConfig();
  if (config === null || config.imageOrigin === null) return null;
  const host = storefrontHostFor(config, (await headers()).get('host'));
  return host === undefined ? null : { origin: config.imageOrigin, marketId: host.marketId };
}
