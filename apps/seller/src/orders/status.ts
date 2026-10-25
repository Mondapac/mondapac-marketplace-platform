import type { BadgeTone } from '@mondapac/ui';
import type { Fulfilment, SellerOrderView } from './types.ts';

export const TONE: Record<Fulfilment | 'ready', BadgeTone> = {
  'to-ship': 'attention',
  ready: 'info',
  shipped: 'info',
  delivered: 'success',
};

/** The end of an id in capitals: the order reference the seller reads out and searches for. */
export const shortId = (id: string): string => id.slice(-8).toUpperCase();

/**
 * The status shown for an order: a to-ship order the shop has said is ready reads "Ready"; the
 * list filter still groups it under "To ship", which is the fulfilment step.
 */
export const statusOf = (order: Pick<SellerOrderView, 'fulfilment' | 'readyAt'>) =>
  order.fulfilment === 'to-ship' && order.readyAt !== null ? 'ready' : order.fulfilment;
