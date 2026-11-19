'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import {
  DUE_PRESETS,
  MONEY_STATES,
  STATUSES,
  filtersOf,
  type Filters,
} from './disputes-list-types.ts';

/**
 * The filter builder: Stripe's status, what happened to the money, the evidence deadline and
 * when the case was opened (a date preset on the clock of the list's zone). The stage is a view,
 * so it is not a filter.
 */
export function DisputesFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('disputes.list.filter');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    {
      id: 'status',
      label: t('name.status'),
      options: STATUSES.map((value) => ({ value, label: t(`status.${value}`) })),
    },
    {
      id: 'money',
      label: t('name.money'),
      options: MONEY_STATES.map((value) => ({ value, label: t(`money.${value}`) })),
    },
    {
      id: 'evidenceDue',
      label: t('name.evidenceDue'),
      options: DUE_PRESETS.map((value) => ({ value, label: t(`due.${value}`) })),
    },
    {
      id: 'opened',
      label: t('name.opened'),
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
