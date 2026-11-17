'use client';

import { Button, CheckboxRow, Switch, TextField } from '@mondapac/ui';
import { useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import {
  AREAS,
  RISKS,
  STATUSES,
  STATUS_BOUND_VIEWS,
  rangeIsBackwards,
  type Filters,
  type View,
} from './types.ts';

type ListField = 'area' | 'risk' | 'status';

/**
 * The filter panel of the queue: Area, Risk and Status as groups of check boxes (any of the ticked
 * values), the days the change was applied between, and "Overdue only". The Status group is absent
 * in a view that fixes the status, and "Overdue only" in the Overdue view (each would contradict
 * the view). Apply sends the draft; the deep-link subject is kept as it is.
 */
export function QueueFilterPanel({
  filters,
  view,
  onApply,
  close,
}: {
  readonly filters: Filters;
  readonly view: View;
  readonly onApply: (filters: Filters) => void;
  readonly close: () => void;
}) {
  const t = useTranslations('system-requests');
  const [draft, setDraft] = useState<Filters>(filters);
  const switchId = useId();
  const statusBound = STATUS_BOUND_VIEWS.includes(view);
  const backwards = rangeIsBackwards(draft);

  const toggle = (field: ListField, value: string, on: boolean) =>
    setDraft((current) => ({
      ...current,
      [field]: on ? [...current[field], value] : current[field].filter((entry) => entry !== value),
    }));
  const group = (field: ListField, values: readonly string[], label: (value: string) => string) => (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 text-sm font-medium text-fg">{t(`filter.name.${field}`)}</legend>
      <div className="grid grid-cols-2 gap-x-3">
        {values.map((value) => (
          <CheckboxRow
            key={value}
            label={label(value)}
            checked={draft[field].includes(value)}
            onChange={(event) => toggle(field, value, event.target.checked)}
          />
        ))}
      </div>
    </fieldset>
  );

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        if (backwards) return;
        onApply({ ...draft, overdue: view === 'overdue' ? false : draft.overdue });
        close();
      }}
    >
      <h2 className="text-lg font-semibold text-fg">{t('filter.title')}</h2>
      {group('area', AREAS, (value) => t(`area.${value}`))}
      {group('risk', RISKS, (value) => t(`risk.${value}`))}
      {statusBound ? null : group('status', STATUSES, (value) => t(`status.${value}`))}
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium text-fg">{t('filter.name.applied')}</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField
            type="date"
            label={t('filter.from')}
            value={draft.from}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
          <TextField
            type="date"
            label={t('filter.to')}
            value={draft.to}
            error={backwards ? t('filter.backwards') : undefined}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </div>
      </fieldset>
      {view === 'overdue' ? null : (
        <div className="flex items-center justify-between gap-3">
          <span id={switchId} className="text-sm font-medium text-fg">
            {t('filter.overdue-only')}
          </span>
          <Switch
            aria-labelledby={switchId}
            checked={draft.overdue}
            onCheckedChange={(overdue) => setDraft({ ...draft, overdue })}
          />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-line-row pt-3">
        <Button variant="secondary" onClick={close}>
          {t('filter.cancel')}
        </Button>
        <Button type="submit" disabled={backwards}>
          {t('filter.apply')}
        </Button>
      </div>
    </form>
  );
}
