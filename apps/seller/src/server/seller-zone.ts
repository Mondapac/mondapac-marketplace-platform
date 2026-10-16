import 'server-only';
import { cache } from 'react';
import { serverGet } from './server-fetch.ts';

/**
 * The seller's own IANA working zone, read once per request, or null when it could not be read
 * (signed out, not a seller yet, API down): times then show in UTC and are labelled so.
 */
export const readSellerZone = cache(async (): Promise<string | null> => {
  const read = await serverGet<{ readonly zone: string }>('sellers/own-zone');
  return read.kind === 'ok' && typeof read.body.zone === 'string' && read.body.zone !== ''
    ? read.body.zone
    : null;
});
