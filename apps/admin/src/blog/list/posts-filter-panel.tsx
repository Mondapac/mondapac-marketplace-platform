'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import { OWNER_TYPES, POST_KINDS } from '../types.ts';
import { FEATURED_VALUES, filtersOf, type Filters } from './posts-list-types.ts';

/**
 * The filter builder: the type, who wrote the post, whether it is featured, and when it last
 * changed (a date preset on the clock of the list's zone).
 */
export function PostsFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('blog.list.filter');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    {
      id: 'kind',
      label: t('name.kind'),
      options: POST_KINDS.map((value) => ({ value, label: t(`kind.${value}`) })),
    },
    {
      id: 'owner',
      label: t('name.owner'),
      options: OWNER_TYPES.map((value) => ({ value, label: t(`owner.${value}`) })),
    },
    {
      id: 'featured',
      label: t('name.featured'),
      options: FEATURED_VALUES.map((value) => ({ value, label: t(`featured.${value}`) })),
    },
    {
      id: 'updated',
      label: t('name.updated'),
      options: DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) })),
    },
  ];
  return (
    <ListFilterPanel
      fields={fields}
      values={filters as Readonly<Record<string, string>>}
      labels={{
        title: t('title'),
        matchAll: ts('filter.match-all'),
        field: ts('filter.field'),
        fieldPlaceholder: ts('filter.field-placeholder'),
        is: ts('filter.is'),
        value: ts('filter.value'),
        valuePlaceholder: ts('filter.value-placeholder'),
        remove: ts('filter.remove'),
        add: ts('filter.add'),
        cancel: ts('filter.cancel'),
        apply: ts('filter.apply'),
      }}
      onApply={(values) => onApply(filtersOf(values))}
      close={close}
    />
  );
}
