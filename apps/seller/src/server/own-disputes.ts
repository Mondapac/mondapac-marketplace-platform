import 'server-only';
import type { OwnDispute, OwnDisputes } from '../disputes/types.ts';
import { serverGet } from './server-fetch.ts';

/**
 * The seller's disputed orders. A notice is never worth failing a page for: an answer that is not
 * ok reads as no notices (the money rules are enforced by the API, not by this banner).
 */
export async function loadOwnDisputes(): Promise<readonly OwnDispute[]> {
  const result = await serverGet<OwnDisputes>('commission-payouts/seller/disputes');
  if (result.kind !== 'ok') return [];
  const disputes = result.body.disputes as readonly OwnDispute[] | undefined;
  return disputes ?? [];
}
