import type { CallContext, Id } from '@mondapac/shared-kernel';

/**
 * How many units of each flash sale have been sold so far, across all orders. The counter is a
 * reservation concern (package T2); until it exists the adapter answers "unknown" (null), and the
 * quote then fails closed: a flash sale is left out of a real order, and counts as sold 0 in a
 * test order only.
 */
export interface FlashSales {
  /**
   * Units sold per promotion; a promotion missing from the map is unknown. Null: no count can be
   * read at all.
   */
  soldUnits(
    context: CallContext,
    promotionIds: readonly Id<'Promotion'>[],
  ): Promise<ReadonlyMap<Id<'Promotion'>, number> | null>;
}

export const FLASH_SALES = Symbol('PROMOTIONS_FLASH_SALES');
