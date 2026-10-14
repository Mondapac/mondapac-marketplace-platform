// Answer of `GET inventory/seller/offers/:offerId/stock` (apps/api seller-inventory.controller.ts).

export const STOCK_EDIT_PERMISSION = 'inventory.stock.edit';

export interface StockCell {
  readonly variantId: string;
  readonly sourceId: string;
  readonly onHand: number;
  readonly held: number;
  /** The version the screen read; the write sends it back. */
  readonly version: number;
  readonly retired: boolean;
}

export interface StockLevelsView {
  readonly offerId: string;
  readonly variants: readonly {
    readonly variantId: string;
    readonly sources: readonly StockCell[];
  }[];
}

/** `PUT .../stock`. */
export interface StockSet {
  readonly stockItemId: string;
  readonly onHand: number;
  readonly version: number;
  readonly changed: boolean;
}
