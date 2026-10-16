import type { MarketContext } from '@mondapac/shared-kernel';
import type { SellUnitKey, SellUnitLabelsMap } from '../../contracts/catalog.facade';

/**
 * The read behind `sellUnitLabels`: per key, the product name and the Variant label of the
 * product's PUBLISHED revision in the asked locale (any locale present when that one is
 * missing). A key whose Offer is unknown, of another Market, or whose product has no published
 * name is absent. Never reads a draft. Runs in a read-only unit.
 */
export interface SellUnitLabelsReader {
  read(
    market: MarketContext,
    keys: readonly SellUnitKey[],
    locale: string,
  ): Promise<SellUnitLabelsMap>;
}

export const SELL_UNIT_LABELS_READER = Symbol('SELL_UNIT_LABELS_READER');
