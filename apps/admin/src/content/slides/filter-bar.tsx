'use client';

import { Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { usePositionLabel } from './slide-labels.tsx';
import {
  SLIDE_KINDS,
  SLIDE_POSITIONS,
  SLIDE_STATUSES,
  type SlideKind,
  type SlideStatus,
} from './slide-types.ts';

export interface FilterValues {
  readonly kind: SlideKind | 'all';
  readonly position: string;
  readonly status: SlideStatus | '';
  readonly search: string;
}

export const NO_FILTERS: FilterValues = { kind: 'all', position: '', status: '', search: '' };

const TOGGLE =
  'inline-flex h-(--mp-size-control) items-center rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-focus';

/**
 * The four filters of the list. The type and the name act in the browser; the position and the
 * status are sent to the API as the `position` and `state` query.
 */
export function FilterBar({
  values,
  onChange,
}: {
  readonly values: FilterValues;
  readonly onChange: (next: FilterValues) => void;
}) {
  const t = useTranslations('content.slides.list');
  const kinds = useTranslations('content.slides.kind');
  const statuses = useTranslations('content.slides.status');
  const positionLabel = usePositionLabel();
  return (
    <div role="search" aria-label={t('filters')} className="flex flex-wrap items-end gap-3">
      <div role="group" aria-label={t('type')} className="flex flex-wrap items-center gap-2">
        {(['all', ...SLIDE_KINDS] as const).map((kind) => {
          const on = values.kind === kind;
          return (
            <button
              key={kind}
              type="button"
              aria-pressed={on}
              onClick={() => onChange({ ...values, kind })}
              className={`${TOGGLE} ${on ? 'border-accent bg-selected font-medium text-link' : 'border-line-control bg-surface text-fg hover:bg-muted'}`}
            >
              {kind === 'all' ? t('all') : kinds(kind)}
            </button>
          );
        })}
      </div>
      <div className="w-full sm:w-48">
        <Select
          label={t('position')}
          value={values.position}
          placeholder={t('any-position')}
          options={SLIDE_POSITIONS.map((position) => ({
            value: position.key,
            label: positionLabel(position.key),
          }))}
          onChange={(event) => onChange({ ...values, position: event.target.value })}
        />
      </div>
      <div className="w-full sm:w-44">
        <Select
          label={t('status')}
          value={values.status}
          placeholder={t('any-status')}
          options={SLIDE_STATUSES.map((status) => ({ value: status, label: statuses(status) }))}
          onChange={(event) =>
            onChange({ ...values, status: event.target.value as SlideStatus | '' })
          }
        />
      </div>
      <div className="w-full sm:min-w-56 sm:flex-1">
        <TextField
          label={t('search')}
          type="search"
          value={values.search}
          autoComplete="off"
          onChange={(event) => onChange({ ...values, search: event.target.value })}
        />
      </div>
    </div>
  );
}
