'use client';

import { RadioGroup } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { SORTS, defaultDirection, type Direction, type Sort } from './products-types.ts';

/**
 * The sort menu (Figma "Sort menu"): one field and the direction, applied as they are chosen. A
 * new field starts in its natural direction (names A to Z, dates newest first).
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
  const kind = sort === 'name' ? 'name' : 'date';
  return (
    <div className="flex flex-col gap-4">
      <RadioGroup
        legend={t('by')}
        name="products-sort"
        value={sort}
        options={SORTS.map((value) => ({ value, label: t(`field.${value}`) }))}
        onChange={(value) => onChange(value as Sort, defaultDirection(value as Sort))}
      />
      <div className="border-t border-line-row pt-3">
        <RadioGroup
          legend={t('order')}
          name="products-sort-direction"
          value={direction}
          options={[
            { value: defaultDirection(sort), label: t(`${kind}.first`) },
            {
              value: defaultDirection(sort) === 'asc' ? 'desc' : 'asc',
              label: t(`${kind}.second`),
            },
          ]}
          onChange={(value) => onChange(sort, value as Direction)}
        />
      </div>
    </div>
  );
}
