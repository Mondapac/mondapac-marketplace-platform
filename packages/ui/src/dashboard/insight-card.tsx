'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from '../icon/icon.tsx';
import { DashboardCard, type DashboardCardProps } from './dashboard.tsx';

export interface InsightTable {
  /** Names the table for assistive technology. */
  readonly caption: string;
  readonly columns: readonly {
    readonly id: string;
    readonly header: string;
    readonly align?: 'start' | 'end';
  }[];
  /** One array of ready-to-show cells per row, in column order. */
  readonly rows: readonly (readonly string[])[];
}

/** The same figures as the chart, as text: a plain table. */
export function InsightTableView({ table }: { readonly table: InsightTable }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">{table.caption}</caption>
      <thead>
        <tr className="border-b border-line text-fg-muted">
          {table.columns.map((column) => (
            <th
              key={column.id}
              scope="col"
              className={`py-1.5 font-medium ${column.align === 'end' ? 'text-end' : 'text-start'}`}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {table.rows.map((row, index) => (
          <tr key={index} className="border-b border-line-row last:border-0">
            {row.map((cell, i) => {
              const column = table.columns[i];
              return (
                <td
                  key={column?.id ?? i}
                  className={`py-1.5 ${column?.align === 'end' ? 'text-end tabular-nums' : 'text-start'}`}
                >
                  {cell}
                </td>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A "?" button that opens a short definition in a panel under it; Escape or a second press closes it. */
export function DefinitionHint({
  label,
  definition,
}: {
  /** Names the button ("What is Store health?"). */
  readonly label: string;
  readonly definition: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent | MouseEvent) => {
      if (event instanceof KeyboardEvent) {
        if (event.key === 'Escape') setOpen(false);
      } else if (box.current !== null && !box.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', close);
    document.addEventListener('mousedown', close);
    return () => {
      document.removeEventListener('keydown', close);
      document.removeEventListener('mousedown', close);
    };
  }, [open]);
  return (
    <span ref={box} className="relative inline-flex">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-11 items-center justify-center rounded-full text-icon-muted hover:text-fg focus-visible:outline-2 focus-visible:outline-focus lg:size-6"
      >
        <Icon name="help" />
      </button>
      {open ? (
        <span
          id={id}
          className="absolute start-0 top-full z-20 mt-1 w-64 max-w-[calc(100vw-3rem)] rounded-md border border-line bg-surface p-3 text-xs font-normal text-fg-secondary shadow-lg"
        >
          {definition}
        </span>
      ) : null}
    </span>
  );
}

export interface InsightCardProps extends Omit<
  DashboardCardProps,
  'children' | 'headerRight' | 'titleAdornment' | 'flush'
> {
  /** What the "?" opens. */
  readonly definition: string;
  readonly definitionLabel: string;
  /** The chart, or the empty / not-enough-data state in its place. */
  readonly chart: ReactNode;
  /** The same figures as text; without it (a state, not a chart) there is no toggle. */
  readonly table?: InsightTable;
  readonly viewAsTable: string;
  readonly viewAsChart: string;
}

/**
 * A dashboard card for a chart that is not the line chart: a "?" definition and a "View as table"
 * toggle in the header, the chart in the body, the same figures as a table on request.
 */
export function InsightCard({
  definition,
  definitionLabel,
  chart,
  table,
  viewAsTable,
  viewAsChart,
  ...frame
}: InsightCardProps) {
  const [asTable, setAsTable] = useState(false);
  const tableId = useId();
  return (
    <DashboardCard
      {...frame}
      titleAdornment={<DefinitionHint label={definitionLabel} definition={definition} />}
    >
      <div id={tableId}>
        {asTable && table !== undefined ? <InsightTableView table={table} /> : chart}
      </div>
      {table === undefined ? null : (
        <div className="mt-2 flex justify-end">
          <button
            type="button"
            aria-controls={tableId}
            aria-pressed={asTable}
            onClick={() => setAsTable((v) => !v)}
            className="inline-flex min-h-11 items-center whitespace-nowrap text-sm font-medium text-link underline lg:min-h-0"
          >
            {asTable ? viewAsChart : viewAsTable}
          </button>
        </div>
      )}
    </DashboardCard>
  );
}
