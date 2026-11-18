'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../date-presets.ts';
import { filtersOf, type Filters } from './invoices-types.ts';

/** The filter builder: Issued, one select of date presets read on the clock of the list's zone. */
export function InvoicesFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('invoices');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    {
      id: 'issued',
      label: t('filter.name.issued'),
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
