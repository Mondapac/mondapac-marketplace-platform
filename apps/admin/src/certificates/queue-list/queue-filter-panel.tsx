'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import { filtersOf, type Filters } from './queue-types.ts';

export interface TypeOption {
  readonly code: string;
  readonly name: string;
}

/**
 * The filter builder: Type (the Market's certification types; offered only to a reader who may
 * view them) and Submitted (a date preset, worked out on the clock of the list's zone). The kind
 * is a view, so it is not a filter.
 */
export function QueueFilterPanel({
  filters,
  types,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly types: readonly TypeOption[];
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('certificates.queue');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    ...(types.length === 0
      ? []
      : [
          {
            id: 'type',
            label: t('filter.name.type'),
            options: types.map((type) => ({ value: type.code, label: type.name })),
          },
        ]),
    {
      id: 'submitted',
      label: t('filter.name.submitted'),
      options: DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) })),
    },
  ];
  return (
    <ListFilterPanel
      fields={fields}
      values={filters as Readonly<Record<string, string>>}
      labels={{
        title: t('filter.title'),
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
