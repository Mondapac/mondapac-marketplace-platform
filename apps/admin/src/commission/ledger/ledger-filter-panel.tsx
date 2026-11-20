'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import { LEDGER_KINDS } from '../types.ts';
import { AMOUNT_STEPS, SIDES, filtersOf, type Filters } from './ledger-list-types.ts';
import { stepLabel } from './ledger-query.ts';

/**
 * The filter builder: the kind of row, whether it adds to or takes from the balance, when it was
 * recorded (a date preset on the clock of the list's zone) and an amount at least or at most, in
 * whole units of the ledger's currency.
 */
export function LedgerFilterPanel({
  filters,
  currency,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly currency: string;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('commission.ledger.list.filter');
  const tk = useTranslations('commission.ledger.kind');
  const ts = useTranslations('sales-lists');
  const locale = useLocale();
  const steps = AMOUNT_STEPS.map((value) => ({
    value,
    label: stepLabel(value, currency, locale),
  }));
  const fields: ListFilterField[] = [
    {
      id: 'kind',
      label: t('name.kind'),
      options: LEDGER_KINDS.map((value) => ({ value, label: tk(value) })),
    },
    {
      id: 'side',
      label: t('name.side'),
      options: SIDES.map((value) => ({ value, label: t(`side.${value}`) })),
    },
    {
      id: 'recorded',
      label: t('name.recorded'),
      options: DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) })),
    },
    { id: 'minAmount', label: t('name.minAmount'), options: steps },
    { id: 'maxAmount', label: t('name.maxAmount'), options: steps },
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
