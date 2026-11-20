'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import {
  READY_VALUES,
  REQUIREMENT_VALUES,
  WAITING_VALUES,
  filtersOf,
  type Filters,
} from './accounts-list-types.ts';

/**
 * The filter builder: Ready for payouts, Details due, Waiting (a bank change waiting period, or
 * payouts paused) and Created (a date preset on the clock of the list's zone). The status is a
 * view, so it is not a filter.
 */
export function AccountsFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('payments.accounts.list.filter');
  const ts = useTranslations('sales-lists');
  const fields: ListFilterField[] = [
    {
      id: 'ready',
      label: t('name.ready'),
      options: READY_VALUES.map((value) => ({ value, label: t(`ready.${value}`) })),
    },
    {
      id: 'requirements',
      label: t('name.requirements'),
      options: REQUIREMENT_VALUES.map((value) => ({ value, label: t(`requirements.${value}`) })),
    },
    {
      id: 'waiting',
      label: t('name.waiting'),
      options: WAITING_VALUES.map((value) => ({ value, label: t(`waiting.${value}`) })),
    },
    {
      id: 'created',
      label: t('name.created'),
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
