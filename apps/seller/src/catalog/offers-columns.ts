// The columns of the seller Offer list. Product and Status are always shown; the rest can be
// hidden, shown and moved. The choice is the seller's own and lives in this browser's storage.

export const OPTIONAL_COLUMNS = ['sku', 'listed', 'submitted'] as const;
export type OfferColumn = (typeof OPTIONAL_COLUMNS)[number];

/** Every column until the seller chooses. */
export const DEFAULT_COLUMNS: readonly OfferColumn[] = ['sku', 'listed', 'submitted'];

/** A saved choice with unknown and repeated ids removed; none saved means the defaults. */
export function cleanColumns(saved: readonly unknown[] | undefined): readonly OfferColumn[] {
  if (saved === undefined) return DEFAULT_COLUMNS;
  const known = saved.filter((id): id is OfferColumn =>
    OPTIONAL_COLUMNS.some((column) => column === id),
  );
  return [...new Set(known)];
}
