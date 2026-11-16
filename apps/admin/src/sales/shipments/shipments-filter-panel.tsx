'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { DATE_PRESETS } from '../date-presets.ts';
import {
  ATTENTIONS,
  DELIVERY_METHODS,
  FILTER_FIELDS,
  filtersOf,
  type Filters,
  type Tab,
} from './shipments-types.ts';

/**
 * The filter builder: Delivery method, Delivery problem, Paid and Shipped, each one select (the
 * dates are presets, worked out on the clock of the list's zone). On the Needs attention tab
 * "Any problem" is the tab itself, so the problem field offers the three codes only.
 */
export function ShipmentsFilterPanel({
  filters,
  tab,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly tab: Tab;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('shipments');
  const ts = useTranslations('sales-lists');
  const to = useTranslations('orders');
  const options = (field: (typeof FILTER_FIELDS)[number]): ListFilterField['options'] => {
    switch (field) {
      case 'deliveryMethod':
        return DELIVERY_METHODS.map((value) => ({
          value,
          label: to(`delivery-method.${value}`),
        }));
      case 'attention':
        return ATTENTIONS.filter((value) => tab !== 'attention' || value !== 'any').map(
          (value) => ({
            value,
            label: t(`problem-filter.${value}`),
          }),
        );
      case 'paid':
      case 'shipped':
        return DATE_PRESETS.map((value) => ({ value, label: ts(`date-preset.${value}`) }));
    }
  };
  const fields: ListFilterField[] = FILTER_FIELDS.map((field) => ({
    id: field,
    label: t(`filter.name.${field}`),
    options: options(field),
  }));
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
