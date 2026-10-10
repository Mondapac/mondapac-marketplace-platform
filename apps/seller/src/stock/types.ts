// Answers of the seller inventory source routes (apps/api seller-inventory.controller.ts).

export const STOCK_VIEW_PERMISSION = 'inventory.stock.view';
export const SOURCE_EDIT_PERMISSION = 'inventory.source.edit';

export interface SourceView {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly position: number;
  readonly address: Readonly<Record<string, string>> | null;
  /** An IANA zone id, or null for the seller's own zone. */
  readonly timeZone: string | null;
  readonly createdAt: string;
}

export interface SourcesView {
  /** The version the screen read; every write sends it back. */
  readonly version: number;
  readonly max: number;
  readonly sources: readonly SourceView[];
}

/** The address form of the Market, from the sellers form descriptors. */
export interface AddressField {
  readonly key: string;
  readonly labelKey: string;
  readonly required: boolean;
  readonly maxLength: number;
}

export interface StockFormOptions {
  readonly fields: readonly AddressField[];
  readonly regionField: string | null;
  readonly regions: readonly string[];
  readonly zones: readonly string[];
}
