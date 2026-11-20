'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../../sales/date-presets.ts';
import { formatMinor, parseAmount } from '../../wallet/money.ts';
import {
  AMOUNT_STEPS,
  APPROVAL_MODES,
  filtersOf,
  statusesOf,
  type Filters,
  type View,
} from './payouts-list-types.ts';

/**
 * The filter builder: Approval (automatic or by an admin) and Created (a date preset, worked out
 * on the clock of the list's zone). The stage is a view, so it is not a filter.
 */
export function PayoutsFilterPanel({
  filters,
  view,
  currency,
  onApply,
  close,
}: {
  readonly filters: Filters;
  /** The view on show: the Status filter offers the states of that view. */
  readonly view: View;
  /** The Market currency of the amount steps; null leaves the amount filters out. */
  readonly currency: string | null;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('payouts.list');
  const ts = useTranslations('sales-lists');
  const tp = useTranslations('payouts');
  const locale = useLocale();
  const amountOptions = (currency: string | null) =>
    currency === null
      ? []
      : AMOUNT_STEPS.flatMap((step) => {
          const parsed = parseAmount(step, currency);
          return parsed.ok
            ? [{ value: step, label: formatMinor(parsed.minor, currency, locale) }]
            : [];
        });
  const amounts = amountOptions(currency);
  const fields: ListFilterField[] = [
    {
      id: 'status',
      label: t('filter.name.status'),
      options: statusesOf(view).map((value) => ({ value, label: tp(`state.${value}`) })),
    },
    {
      id: 'approvalMode',
      label: t('filter.name.approvalMode'),
      options: APPROVAL_MODES.map((value) => ({ value, label: t(`filter.mode.${value}`) })),
    },
    {
      id: 'created',
      label: t('filter.name.created'),
      options: DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) })),
    },
    ...(amounts.length === 0
      ? []
      : [
          { id: 'minAmount', label: t('filter.name.minAmount'), options: amounts },
          { id: 'maxAmount', label: t('filter.name.maxAmount'), options: amounts },
        ]),
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
