'use client';

import { Button, ListColumnsPanel, ListSortPanel, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState, type FormEvent } from 'react';
import {
  DEFAULT_COLUMNS,
  OPTIONAL_COLUMNS,
  cleanColumns,
  defaultDirection,
  isScore,
  type FilterField,
  type Filters,
  type OptionalColumn,
} from './health-list-query.ts';
import { SORTS, type Direction, type Sort } from './health-types.ts';

/**
 * The filter panel of the "Needs a look" list: the score as a range, both ends included. A value
 * that is not a whole number from 0 to 100, or a range that ends before it starts, is refused here
 * as the API would refuse it.
 */
export function HealthFilterPanel({
  filters,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('sellers.health-queue.filter');
  const [draft, setDraft] = useState({
    minScore: filters.minScore ?? '',
    maxScore: filters.maxScore ?? '',
  });
  const [errors, setErrors] = useState<Partial<Record<FilterField, string>>>({});
  const set = (field: FilterField, value: string) =>
    setDraft((current) => ({ ...current, [field]: value }));

  function apply(event: FormEvent) {
    event.preventDefault();
    const next: Record<FilterField, string> = { minScore: '', maxScore: '' };
    const problems: Partial<Record<FilterField, string>> = {};
    for (const field of ['minScore', 'maxScore'] as const) {
      const value = draft[field].trim();
      if (value === '') continue;
      if (isScore(value)) next[field] = String(Number(value));
      else problems[field] = t('error.score');
    }
    if (
      Object.keys(problems).length === 0 &&
      next.minScore !== '' &&
      next.maxScore !== '' &&
      Number(next.maxScore) < Number(next.minScore)
    ) {
      problems.maxScore = t('error.range');
    }
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      return;
    }
    onApply({
      ...(next.minScore === '' ? {} : { minScore: next.minScore }),
      ...(next.maxScore === '' ? {} : { maxScore: next.maxScore }),
    });
    close();
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={apply} noValidate>
      <h2 className="text-base font-semibold">{t('title')}</h2>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-fg">{t('name.score')}</legend>
        <div className="grid grid-cols-2 gap-3">
          <TextField
            label={t('from')}
            inputMode="numeric"
            value={draft.minScore}
            error={errors.minScore}
            onChange={(event) => set('minScore', event.target.value)}
          />
          <TextField
            label={t('to')}
            inputMode="numeric"
            value={draft.maxScore}
            error={errors.maxScore}
            onChange={(event) => set('maxScore', event.target.value)}
          />
        </div>
      </fieldset>
      <div className="flex justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {t('cancel')}
        </Button>
        <Button type="submit">{t('apply')}</Button>
      </div>
    </form>
  );
}

/** The sort menu: one field and the direction, applied as they are chosen. */
export function HealthSortPanel({
  sort,
  direction,
  onChange,
}: {
  readonly sort: Sort;
  readonly direction: Direction;
  readonly onChange: (sort: Sort, direction: Direction) => void;
}) {
  const t = useTranslations('sellers.health-queue.sort');
  return (
    <ListSortPanel
      name="health-queue-sort"
      sort={sort}
      direction={direction}
      fields={SORTS.map((value) => ({ id: value, label: t(`field.${value}`) }))}
      defaultDirection={(value) => defaultDirection(value as Sort)}
      orderLabels={(value) => {
        const kind = value === 'name' ? 'name' : value === 'day' ? 'date' : 'score';
        return [t(`${kind}.first`), t(`${kind}.second`)];
      }}
      labels={{ by: t('by'), order: t('order') }}
      onChange={(value, next) => onChange(value as Sort, next)}
    />
  );
}

/** The column picker: the seller is always shown, the rest can be hidden, shown and moved. */
export function HealthColumnsPanel({
  columns,
  onSave,
  close,
}: {
  readonly columns: readonly OptionalColumn[];
  readonly onSave: (columns: readonly OptionalColumn[]) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('sellers.health-queue');
  const ts = useTranslations('sales-lists.columns');
  return (
    <ListColumnsPanel
      columns={columns}
      optional={OPTIONAL_COLUMNS}
      defaults={DEFAULT_COLUMNS}
      fixed={[{ id: 'seller', label: t('col.seller') }]}
      optionalLabel={(column) => t(`col.${column as OptionalColumn}`)}
      labels={{
        title: ts('title'),
        help: ts('help'),
        always: ts('always'),
        up: (column) => ts('up', { column }),
        down: (column) => ts('down', { column }),
        reset: ts('reset'),
        save: ts('save'),
      }}
      onSave={(next) => onSave(cleanColumns(next))}
      close={close}
    />
  );
}
