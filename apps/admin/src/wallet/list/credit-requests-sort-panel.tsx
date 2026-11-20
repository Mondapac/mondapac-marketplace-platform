'use client';

import { ListSortPanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  SORTS,
  defaultDirection,
  type Direction,
  type Sort,
} from './credit-requests-list-types.ts';

/** The sort menu: one field and the direction, applied as they are chosen. */
export function CreditRequestsSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: Sort;
  readonly direction: Direction;
  readonly onChange: (sort: Sort, direction: Direction) => void;
}) {
  const t = useTranslations('wallet.list.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORTS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={(value) => defaultDirection(value as Sort)}
      orderLabels={(value) => [t(`${value as Sort}.first`), t(`${value as Sort}.second`)]}
      labels={{ by: t('by'), order: t('order') }}
      name="credit-requests-sort"
      onChange={(value, next) => onChange(value as Sort, next)}
    />
  );
}
