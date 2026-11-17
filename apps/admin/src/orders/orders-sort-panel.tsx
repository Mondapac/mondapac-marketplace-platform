'use client';

import { ListSortPanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { SORT_FIELDS, defaultDirection, type Direction, type SortField } from './orders-query.ts';

/**
 * The sort menu: one field and the direction, applied as they are chosen. Times read "Newest
 * first / Oldest first"; the total reads "Highest first / Lowest first".
 */
export function OrdersSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: SortField;
  readonly direction: Direction;
  readonly onChange: (sort: SortField, direction: Direction) => void;
}) {
  const t = useTranslations('orders.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORT_FIELDS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={() => defaultDirection()}
      orderLabels={(value) => {
        const kind = value === 'total' ? 'amount' : 'date';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      name="orders-sort"
      onChange={(value, next) => onChange(value as SortField, next)}
    />
  );
}
