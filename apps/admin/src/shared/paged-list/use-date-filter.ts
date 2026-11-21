'use client';

import type { PagedFilterField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useMemo } from 'react';
import { DATE_PRESETS, isDatePreset, presetRange } from '../../sales/date-presets.ts';

/**
 * The preset date filter of a super list (shared kit `range` field): a field of the filter panel
 * whose presets (Today, Last 7 days, ...) the list sends as two instants, and the function that
 * turns a preset into them on the clock of the list's zone, read at each load (ADR-0005).
 */
export function useDateFilter(options: {
  /** The filter field id and the sort id it is named by, e.g. `created`. */
  readonly id: string;
  /** The label of the field, already translated. */
  readonly label: string;
  /** The query keys of the two instants, e.g. `createdFrom` and `createdTo`. */
  readonly range: { readonly from: string; readonly to: string };
  /** The IANA zone of the table's times (ADR-0005). */
  readonly zone: string;
}): {
  readonly field: PagedFilterField;
  readonly dateRange: (preset: string) => ReturnType<typeof presetRange> | null;
} {
  const tp = useTranslations('sales-lists.date-preset');
  const { id, label, zone } = options;
  const { from, to } = options.range;
  const field = useMemo<PagedFilterField>(
    () => ({
      id,
      label,
      range: { from, to },
      options: DATE_PRESETS.map((preset) => ({ value: preset, label: tp(preset) })),
    }),
    [id, label, from, to, tp],
  );
  const dateRange = useCallback(
    (preset: string) => (isDatePreset(preset) ? presetRange(preset, zone, new Date()) : null),
    [zone],
  );
  return { field, dateRange };
}
