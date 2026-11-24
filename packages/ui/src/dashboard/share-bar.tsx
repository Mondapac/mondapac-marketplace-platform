'use client';

import { useId, useState } from 'react';
import { bucketCategories, type CategoryInput } from './chart-categories.ts';
import { colorClasses } from './chart-palette.ts';
import {
  ChartEmpty,
  chartStateMessage,
  type ChartDataState,
  type ChartEmptyLabels,
} from './chart-states.tsx';

/** One part of the whole. `value` is gross and non-negative. */
export type ShareBarItem = CategoryInput;

export interface ShareBarProps {
  /** The text alternative and the table caption ("New and returning customers"). */
  readonly title: string;
  /** The parts of one whole. At most five are named; the rest are summed into "Other". */
  readonly items: readonly ShareBarItem[];
  readonly formatValue: (value: number) => string;
  readonly formatShare?: (share: number) => string;
  readonly otherLabel: string;
  /** Decided by the caller: no data in the period, or too little to read. */
  readonly state?: ChartDataState;
  readonly emptyLabels?: Partial<ChartEmptyLabels>;
  readonly droppedNote?: (dropped: number) => string;
  readonly labels: {
    readonly viewAsTable: string;
    readonly viewAsChart: string;
    readonly categoryColumn: string;
    readonly valueColumn: string;
    readonly shareColumn: string;
  };
}

const defaultShare = (share: number) => {
  const p = Math.round(share * 1000) / 10;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
};

/**
 * One horizontal bar of 100% split into parts (new and returning customers, traffic sources),
 * in the same palette as the donut. The legend prints every value and share, hovering a legend
 * row highlights its part, and "View as table" shows the same figures as text.
 */
export function ShareBar({
  title,
  items,
  formatValue,
  formatShare = defaultShare,
  otherLabel,
  state,
  emptyLabels,
  droppedNote,
  labels,
}: ShareBarProps) {
  const [table, setTable] = useState(false);
  const [active, setActive] = useState<number | null>(null);
  const tableId = useId();
  const { slices, dropped } = bucketCategories(items, otherLabel);
  if (state !== undefined || slices.length === 0)
    return <ChartEmpty message={chartStateMessage(state ?? 'empty', emptyLabels)} height={72} />;

  const toggle = (
    <button
      type="button"
      aria-controls={tableId}
      onClick={() => setTable((v) => !v)}
      className="shrink-0 text-sm font-medium text-link underline"
    >
      {table ? labels.viewAsChart : labels.viewAsTable}
    </button>
  );
  return (
    <div className="flex flex-col gap-3">
      <div className="flex justify-end">{toggle}</div>
      <div id={tableId}>
        {table ? (
          <div className="overflow-auto rounded-md border border-line">
            <table className="w-full text-sm">
              <caption className="sr-only">{title}</caption>
              <thead className="bg-muted text-fg-secondary">
                <tr>
                  <th scope="col" className="px-3 py-2 text-start font-medium">
                    {labels.categoryColumn}
                  </th>
                  <th scope="col" className="px-3 py-2 text-end font-medium">
                    {labels.valueColumn}
                  </th>
                  <th scope="col" className="px-3 py-2 text-end font-medium">
                    {labels.shareColumn}
                  </th>
                </tr>
              </thead>
              <tbody>
                {slices.map((s) => (
                  <tr key={s.id} className="border-t border-line-row">
                    <th scope="row" className="px-3 py-2 text-start font-normal text-fg-secondary">
                      <span className="flex items-center gap-2">
                        <span
                          aria-hidden="true"
                          data-swatch=""
                          className={`size-3 shrink-0 rounded-sm ${colorClasses(s.colorKey).bg}`}
                        />
                        <span className="min-w-0 break-words" title={s.label}>
                          {s.label}
                        </span>
                      </span>
                    </th>
                    <td className="px-3 py-2 text-end text-fg tabular-nums">
                      {formatValue(s.value)}
                    </td>
                    <td className="px-3 py-2 text-end text-fg-secondary tabular-nums">
                      {formatShare(s.share)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div
              role="img"
              aria-label={`${title}: ${slices.map((s) => `${s.label} ${formatShare(s.share)}`).join(', ')}`}
              data-chart="share-bar"
              className="flex h-7 w-full gap-0.5 overflow-hidden rounded-md"
              onPointerLeave={() => setActive(null)}
            >
              {slices.map((s, i) => (
                <span
                  key={s.id}
                  data-part={s.id}
                  onPointerEnter={() => setActive(i)}
                  style={{ flexGrow: s.share, flexBasis: 0, minWidth: 3 }}
                  className={`block h-full ${colorClasses(s.colorKey).bg} ${
                    active !== null && active !== i ? 'opacity-50' : ''
                  }`}
                />
              ))}
            </div>
            <ul className="flex flex-col text-sm" onPointerLeave={() => setActive(null)}>
              {slices.map((s, i) => (
                <li
                  key={s.id}
                  data-legend={s.id}
                  tabIndex={0}
                  onPointerEnter={() => setActive(i)}
                  onFocus={() => setActive(i)}
                  onBlur={() => setActive(null)}
                  className={`grid grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-2 rounded-md px-2 py-1 focus-visible:outline-2 focus-visible:outline-focus ${
                    active === i ? 'bg-muted' : ''
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`size-3 shrink-0 rounded-sm ${colorClasses(s.colorKey).bg}`}
                  />
                  <span className="min-w-0 break-words text-fg-secondary" title={s.label}>
                    {s.label}
                  </span>
                  <span className="min-w-20 text-end font-medium text-fg tabular-nums">
                    {formatValue(s.value)}
                  </span>
                  <span className="w-14 text-end text-fg-muted tabular-nums">
                    {formatShare(s.share)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {dropped > 0 && droppedNote !== undefined ? (
        <p className="text-xs text-fg-muted" data-dropped-note="">
          {droppedNote(dropped)}
        </p>
      ) : null}
    </div>
  );
}
