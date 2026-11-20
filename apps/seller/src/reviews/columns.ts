// The details a review card can show. The stars, the title and the text are always there; the
// rest can be hidden, shown and moved. The choice is the seller's own and lives in this browser.

export const OPTIONAL_COLUMNS = ['published', 'product', 'order', 'reply'] as const;
export type ReviewColumn = (typeof OPTIONAL_COLUMNS)[number];

/** Every detail until the seller chooses. */
export const DEFAULT_COLUMNS: readonly ReviewColumn[] = ['published', 'product', 'order', 'reply'];

/** A saved choice with unknown and repeated ids removed; none saved means the defaults. */
export function cleanColumns(saved: readonly unknown[] | undefined): readonly ReviewColumn[] {
  if (saved === undefined) return DEFAULT_COLUMNS;
  const known = saved.filter((id): id is ReviewColumn =>
    OPTIONAL_COLUMNS.some((column) => column === id),
  );
  return [...new Set(known)];
}
