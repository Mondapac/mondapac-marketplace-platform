'use client';

import { ListSortPanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { SORTS, defaultDirection, type Direction, type Sort } from './invoices-types.ts';

/**
 * The sort menu (page numbers only): one field and the direction, applied as they are chosen.
 * Issued reads "Newest first / Oldest first"; the amount reads "Highest first / Lowest first".
 */
export function InvoicesSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: Sort;
  readonly direction: Direction;
  readonly onChange: (sort: Sort, direction: Direction) => void;
}) {
  const t = useTranslations('invoices.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORTS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={() => defaultDirection()}
      orderLabels={(value) => {
        const kind = value === 'amount' ? 'amount' : 'date';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      name="invoices-sort"
      onChange={(value, next) => onChange(value as Sort, next)}
    />
  );
}
