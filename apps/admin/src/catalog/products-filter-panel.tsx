'use client';

import { Button, IconButton, Select, type SelectOption } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import {
  FILTER_FIELDS,
  SCOPES,
  STATUSES,
  type CategoryTree,
  type FilterField,
  type Filters,
  type Scope,
  type Status,
} from './products-types.ts';

interface Condition {
  readonly key: number;
  readonly field: FilterField | '';
  readonly value: string;
}

/** The conditions of a filter set, one row each; a row with no value yet is dropped on apply. */
function rowsOf(filters: Filters): Condition[] {
  return FILTER_FIELDS.flatMap((field, index) => {
    const value = filters[field];
    return value === undefined ? [] : [{ key: index, field, value }];
  });
}

function filtersOf(rows: readonly Condition[]): Filters {
  const next: { status?: Status; scope?: Scope; categoryId?: string } = {};
  for (const row of rows) {
    if (row.field === '' || row.value === '') continue;
    if (row.field === 'status') next.status = row.value as Status;
    else if (row.field === 'scope') next.scope = row.value as Scope;
    else next.categoryId = row.value;
  }
  return next;
}

/**
 * The filter builder (Figma "Filter panel"): one row per condition (field, "is", value), Add
 * condition, Cancel and Apply. Every condition must hold. A field is used once, so its row offers
 * the fields no other row has taken. The category field is absent when the tree did not load.
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
  const [rows, setRows] = useState<readonly Condition[]>(() => {
    const start = rowsOf(filters);
    return start.length > 0 ? start : [{ key: 100, field: '', value: '' }];
  });
  const [next, setNext] = useState(200);
  const fields = FILTER_FIELDS.filter((field) => field !== 'categoryId' || categories.length > 0);

  const valueOptions = (field: FilterField | ''): SelectOption[] => {
    if (field === 'status') {
      return STATUSES.map((value) => ({ value, label: ts(`status.${value}`) }));
    }
    if (field === 'scope') return SCOPES.map((value) => ({ value, label: ts(`scope.${value}`) }));
    if (field === 'categoryId') {
      return categories.map((category) => ({
        value: category.id,
        label: `${'– '.repeat(category.depth)}${category.name}`,
      }));
    }
    return [];
  };
  const change = (key: number, patch: Partial<Condition>) =>
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const taken = (key: number) =>
    new Set(rows.filter((row) => row.key !== key && row.field !== '').map((row) => row.field));
  const canAdd = rows.length < fields.length;

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onApply(filtersOf(rows));
        close();
      }}
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h2 className="text-lg font-semibold text-fg">{t('title')}</h2>
        <p className="text-sm text-fg-muted">{t('match-all')}</p>
      </div>
      <ul className="flex flex-col gap-3">
        {rows.map((row) => {
          const used = taken(row.key);
          return (
            <li key={row.key} className="flex flex-wrap items-center gap-2 [&_label]:sr-only">
              <div className="min-w-32 basis-full sm:basis-0 sm:flex-1">
                <Select
                  label={t('field')}
                  value={row.field}
                  placeholder={t('field-placeholder')}
                  onChange={(event) =>
                    change(row.key, { field: event.target.value as FilterField | '', value: '' })
                  }
                  options={fields
                    .filter((field) => !used.has(field))
                    .map((field) => ({ value: field, label: t(`name.${field}`) }))}
                />
              </div>
              <span className="text-sm text-fg-muted">{t('is')}</span>
              <div className="min-w-32 flex-1">
                <Select
                  label={t('value')}
                  value={row.value}
                  placeholder={t('value-placeholder')}
                  disabled={row.field === ''}
                  onChange={(event) => change(row.key, { value: event.target.value })}
                  options={valueOptions(row.field)}
                />
              </div>
              <IconButton
                icon="x"
                label={t('remove')}
                disabled={rows.length === 1 && row.field === ''}
                onClick={() =>
                  setRows((current) =>
                    current.length === 1
                      ? [{ key: next, field: '', value: '' }]
                      : current.filter((entry) => entry.key !== row.key),
                  )
                }
              />
            </li>
          );
        })}
      </ul>
      {canAdd ? (
        <div>
          <Button
            variant="link"
            className="min-h-(--mp-size-control-sm)"
            onClick={() => {
              setRows((current) => [...current, { key: next, field: '', value: '' }]);
              setNext((value) => value + 1);
            }}
          >
            {t('add')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {t('cancel')}
        </Button>
        <Button type="submit">{t('apply')}</Button>
      </div>
    </form>
  );
}
