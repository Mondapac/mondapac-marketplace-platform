import type { ReactNode } from 'react';

export interface DataListRow {
  readonly label: string;
  /** null shows the DataRow Missing state: the list's `missing` text, muted. */
  readonly value: ReactNode | null;
}

/**
 * Label and value pairs (Figma DataRow). Every list shares one label column width
 * (--mp-size-data-label), so sibling cards on a page line up; on a phone the label sits above
 * its value.
 */
export function DataList({
  rows,
  missing,
}: {
  readonly rows: readonly DataListRow[];
  /** Shown for a row without a value, such as "Not given". */
  readonly missing: string;
}) {
  return (
    <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-[minmax(0,var(--mp-size-data-label))_minmax(0,1fr)] sm:gap-y-3">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-fg-muted">{row.label}</dt>
          <dd className="whitespace-pre-line break-words font-medium text-fg max-sm:mb-3">
            {row.value === null ? (
              <span className="font-normal text-fg-muted">{missing}</span>
            ) : (
              row.value
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}
