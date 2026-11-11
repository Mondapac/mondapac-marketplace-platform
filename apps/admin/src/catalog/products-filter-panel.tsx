'use client';

import { ListFilterPanel, type ListFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import {
  FILTER_FIELDS,
  SCOPES,
  STATUSES,
  type CategoryTree,
  type Filters,
  type Scope,
  type Status,
} from './products-types.ts';

/**
 * The filter builder (Figma "Filter panel"): one row per condition (field, "is", value), Add
 * condition, Cancel and Apply. Every condition must hold. The category field is absent when the
 * tree did not load. The builder is the shared list filter of `@mondapac/ui`; this gives it the
 * admin's fields and words.
 */
export function ProductsFilterPanel({
  filters,
  categories,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly categories: CategoryTree['categories'];
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('catalog.products.filter');
  const ts = useTranslations('catalog.products');
  const options = (field: (typeof FILTER_FIELDS)[number]): ListFilterField['options'] => {
    if (field === 'status') {
      return STATUSES.map((value) => ({ value, label: ts(`status.${value}`) }));
    }
    if (field === 'scope') return SCOPES.map((value) => ({ value, label: ts(`scope.${value}`) }));
    return categories.map((category) => ({
      value: category.id,
      label: `${'– '.repeat(category.depth)}${category.name}`,
    }));
  };
  const fields: ListFilterField[] = FILTER_FIELDS.filter(
    (field) => field !== 'categoryId' || categories.length > 0,
  ).map((field) => ({ id: field, label: t(`name.${field}`), options: options(field) }));
  return (
    <ListFilterPanel
      fields={fields}
      values={filters as Readonly<Record<string, string>>}
      labels={{
        title: t('title'),
        matchAll: t('match-all'),
        field: t('field'),
        fieldPlaceholder: t('field-placeholder'),
        is: t('is'),
        value: t('value'),
        valuePlaceholder: t('value-placeholder'),
        remove: t('remove'),
        add: t('add'),
        cancel: t('cancel'),
        apply: t('apply'),
      }}
      onApply={(values) => {
        const next: { status?: Status; scope?: Scope; categoryId?: string } = {};
        if (values['status'] !== undefined) next.status = values['status'] as Status;
        if (values['scope'] !== undefined) next.scope = values['scope'] as Scope;
        if (values['categoryId'] !== undefined) next.categoryId = values['categoryId'];
        onApply(next);
      }}
      close={close}
    />
  );
}
