'use client';

import { CARD_TABLE } from '../data/card-table.ts';
import { ListSkeletonRows, type ListSkeletonKind } from '../list/list-skeleton.tsx';
import { SettingsSkeleton, type SkeletonSection } from './settings-skeleton.tsx';
import { useDelayedLoading } from './use-delayed-loading.ts';

/**
 * Panel loading L4: shaped placeholders for the parts of a page that load on their own (a list
 * that is not a super list, a form, a detail panel). They replace the generic SkeletonRows, which
 * now stays only for small sections inside dialogs. Each one has one role="status" with its
 * label, shows its bars only after 200 ms (a fast answer never flashes), and adds "Still
 * loading…" at 10 s. With reduced motion the bars do not pulse.
 */

function Status({
  label,
  slow,
  slowLabel,
}: {
  readonly label: string;
  readonly slow: boolean;
  readonly slowLabel: string;
}) {
  return (
    <p role="status" className={slow ? 'text-sm text-fg-muted' : 'sr-only'}>
      {slow ? slowLabel : label}
    </p>
  );
}

/** One column of a table skeleton: its real header and the shape of its cells. */
export interface TableSkeletonColumn {
  /** The column's real header text (shown in the header row, and as the card label below 1024 px). */
  readonly header: string;
  readonly kind: ListSkeletonKind;
  /**
   * Where the cell sits on the card below 1024 px, as in CARD_TABLE: the card title, the corner
   * beside it (a status), or a labelled line. Defaults: the first column is the title, a status is
   * the corner, the rest are labelled.
   */
  readonly place?: 'cell' | 'corner' | 'labelled';
  /** Extra class names of the real cell (a width or an end alignment). */
  readonly className?: string;
  /** The real header is for screen readers only (an Actions column): keep the column, hide its text. */
  readonly headerHidden?: boolean;
}

export interface TableSkeletonProps {
  /** What is loading, for screen readers ("Loading brands"). */
  readonly label: string;
  /** "Still loading…", shown after 10 s. */
  readonly slowLabel: string;
  readonly columns: readonly TableSkeletonColumn[];
  /** Rows the list shows when full (at most 10 are drawn). */
  readonly rows: number;
  /** Draw the bordered card around the table (false when the page's own card is already there). */
  readonly framed?: boolean;
}

function placeOf(column: TableSkeletonColumn, index: number) {
  if (column.place !== undefined) return column.place;
  if (index === 0) return 'cell';
  if (column.kind === 'status') return 'corner';
  return 'labelled';
}

/**
 * The placeholder of a list that loads before its table is drawn: the table with its real
 * headers and skeleton rows in the shape of its columns (labelled cards below 1024 px).
 */
export function TableSkeleton({
  label,
  slowLabel,
  columns,
  rows,
  framed = true,
}: TableSkeletonProps) {
  const loading = useDelayedLoading(true);
  return (
    <div className="flex flex-col gap-2" data-testid="table-skeleton">
      {loading.visible ? (
        <div
          aria-hidden="true"
          className={framed ? 'overflow-hidden rounded-lg border border-line bg-surface' : ''}
        >
          <table className={CARD_TABLE.table}>
            <thead className={CARD_TABLE.head}>
              <tr>
                {columns.map((column, index) => (
                  <th
                    key={index}
                    scope="col"
                    className={`px-4 py-3 font-medium ${column.kind === 'number' ? 'text-end' : ''}`}
                  >
                    {column.headerHidden ? (
                      <span className="sr-only">{column.header}</span>
                    ) : (
                      column.header
                    )}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              <ListSkeletonRows
                rows={Math.max(1, Math.min(rows, 10))}
                cells={columns.map((column, index) => {
                  const place = placeOf(column, index);
                  return {
                    kind: column.kind,
                    className: `${CARD_TABLE[place]} ${column.className ?? ''}`,
                    ...(place === 'labelled' ? { label: column.header } : {}),
                  };
                })}
              />
            </tbody>
          </table>
        </div>
      ) : null}
      <Status label={label} slow={loading.slow} slowLabel={slowLabel} />
    </div>
  );
}

export interface FormSkeletonProps {
  readonly label: string;
  readonly slowLabel: string;
  /** The form's cards and their field counts, as in SettingsSkeleton. */
  readonly sections: readonly SkeletonSection[];
  /** Draw the page title bars (false when the real title is already on the page). */
  readonly header?: boolean;
}

/** The placeholder of a form that loads its values: SettingsSkeleton on the shared timing. */
export function FormSkeleton({ label, slowLabel, sections, header = false }: FormSkeletonProps) {
  const loading = useDelayedLoading(true);
  return (
    <SettingsSkeleton
      label={label}
      sections={sections}
      header={header}
      visible={loading.visible}
      slow={loading.slow}
      slowLabel={slowLabel}
    />
  );
}

export interface DetailSkeletonProps {
  readonly label: string;
  readonly slowLabel: string;
  /** Label and value pairs of the panel. */
  readonly rows: number;
  /** Draw a heading bar at the top of the card (the record's name). */
  readonly title?: boolean;
  /** Draw the bordered card around it. */
  readonly framed?: boolean;
}

const LABEL_WIDTHS = ['w-24', 'w-32', 'w-20', 'w-28'] as const;
const VALUE_WIDTHS = ['w-48', 'w-64', 'w-40', 'w-56'] as const;

/**
 * The placeholder of a detail panel: a heading bar and label/value pairs laid out like DataList
 * (the label column of --mp-size-data-label from 640 px, stacked below).
 */
export function DetailSkeleton({
  label,
  slowLabel,
  rows,
  title = true,
  framed = true,
}: DetailSkeletonProps) {
  const loading = useDelayedLoading(true);
  return (
    <div className="flex flex-col gap-2" data-testid="detail-skeleton">
      {loading.visible ? (
        <div
          aria-hidden="true"
          className={`flex flex-col gap-4 motion-safe:animate-pulse ${framed ? 'rounded-lg border border-line bg-surface p-4 sm:p-5' : ''}`}
        >
          {title ? (
            <span className="flex h-7 items-center">
              <span className="block h-5 w-56 max-w-full rounded-sm bg-muted" />
            </span>
          ) : null}
          <div className="flex flex-col gap-3">
            {Array.from({ length: rows }, (_, row) => (
              <div
                key={row}
                data-skeleton="detail-row"
                className="grid gap-1 sm:grid-cols-[var(--mp-size-data-label)_minmax(0,1fr)] sm:gap-4"
              >
                <span className="flex h-5 items-center">
                  <span
                    className={`block h-3 rounded-sm bg-muted ${LABEL_WIDTHS[row % LABEL_WIDTHS.length]}`}
                  />
                </span>
                <span className="flex h-5 items-center">
                  <span
                    className={`block h-3.5 max-w-full rounded-sm bg-muted ${VALUE_WIDTHS[row % VALUE_WIDTHS.length]}`}
                  />
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <Status label={label} slow={loading.slow} slowLabel={slowLabel} />
    </div>
  );
}
