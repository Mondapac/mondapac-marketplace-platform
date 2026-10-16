import type { ReactNode } from 'react';

export interface DataListRow {
  readonly label: string;
  readonly value: ReactNode;
}

/**
 * Label and value pairs (Figma DataRow). Every list shares one label column width, so sibling
 * cards on a page line up; on a phone the label sits above its value.
 */
export function DataList({ rows }: { readonly rows: readonly DataListRow[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-1 sm:gap-y-3 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
      {rows.map((row) => (
        <div key={row.label} className="contents">
          <dt className="text-fg-muted">{row.label}</dt>
          <dd className="whitespace-pre-line break-words font-medium text-fg max-sm:mb-3">
            {row.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
