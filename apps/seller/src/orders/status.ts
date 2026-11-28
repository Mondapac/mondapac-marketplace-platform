import type { BadgeTone } from '@mondapac/ui';
import type { Fulfilment, SellerOrderView } from './types.ts';

export const TONE: Record<Fulfilment | 'ready' | 'cancelled', BadgeTone> = {
  'to-ship': 'attention',
  ready: 'info',
  // Handed over and out of the seller's hands: neutral, so it reads apart from Ready (info).
  shipped: 'neutral',
  delivered: 'success',
  cancelled: 'neutral',
};

/** The end of an id in capitals: the order reference the seller reads out (a search needs the whole id). */
export const shortId = (id: string): string => id.slice(-8).toUpperCase();

/**
 * The status shown for an order: a to-ship order the shop has said is ready reads "Ready", and one
 * an admin cancelled reads "Cancelled"; the list filter still groups both under "To ship", which
 * is the fulfilment step.
 */
export const statusOf = (
  order: Pick<SellerOrderView, 'fulfilment' | 'readyAt'> & {
    readonly cancelledAt?: string | null;
  },
) =>
  order.cancelledAt != null
    ? 'cancelled'
    : order.fulfilment === 'to-ship' && order.readyAt !== null
      ? 'ready'
      : order.fulfilment;
