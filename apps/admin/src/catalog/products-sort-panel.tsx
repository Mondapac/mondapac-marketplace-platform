'use client';

import { ListSortPanel } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { SORTS, defaultDirection, type Direction, type Sort } from './products-types.ts';

/**
 * The sort menu (Figma "Sort menu"): one field and the direction, applied as they are chosen. A
 * new field starts in its natural direction (names A to Z, dates newest first). The menu itself is
 * the shared list menu of `@mondapac/ui`; this gives it the admin's words.
 */
export function ProductsSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: Sort;
  readonly direction: Direction;
  readonly onChange: (sort: Sort, direction: Direction) => void;
}) {
  const t = useTranslations('catalog.products.sort');
  return (
    <ListSortPanel
      sort={sort}
      direction={direction}
      fields={SORTS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={(value) => defaultDirection(value as Sort)}
      orderLabels={(value) => {
        const kind = value === 'name' ? 'name' : 'date';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      name="products-sort"
      onChange={(value, next) => onChange(value as Sort, next)}
    />
  );
}
