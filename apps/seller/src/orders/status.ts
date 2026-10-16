import type { BadgeTone } from '@mondapac/ui';
import type { Fulfilment } from './types.ts';

export const TONE: Record<Fulfilment, BadgeTone> = {
  'to-ship': 'attention',
  shipped: 'info',
  delivered: 'success',
};

/** The end of an id in capitals: the order reference the seller reads out and searches for. */
export const shortId = (id: string): string => id.slice(-8).toUpperCase();
