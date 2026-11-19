// The columns of the seller Customers list. The code is always shown (it links to the customer);
// the rest can be hidden, shown and reordered. The choice is the account's own and lives in this
// browser's storage, as the product and order lists' do.

export const OPTIONAL_COLUMNS = [
  'firstName',
  'orders',
  'spent',
  'lastOrder',
  'badges',
  'firstOrder',
  'followed',
] as const;
export type CustomerColumn = (typeof OPTIONAL_COLUMNS)[number];

export const DEFAULT_COLUMNS: readonly CustomerColumn[] = [
  'firstName',
  'orders',
  'spent',
  'lastOrder',
  'badges',
];

/** The columns a stored choice names: unknown and repeated ids are dropped. */
export function cleanColumns(saved: readonly unknown[] | undefined): readonly CustomerColumn[] {
  if (saved === undefined) return DEFAULT_COLUMNS;
  const known = saved.filter((id): id is CustomerColumn =>
    OPTIONAL_COLUMNS.some((column) => column === id),
  );
  return [...new Set(known)];
}
