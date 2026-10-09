import type { ReactNode } from 'react';

/** A labelled list of facts; a row whose value is null is left out. */
export function FieldList({
  rows,
}: {
  readonly rows: readonly { readonly label: string; readonly value: ReactNode | null }[];
}) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
      {rows
        .filter((row) => row.value !== null)
        .map((row) => (
          <div key={row.label} className="contents">
            <dt className="text-fg-muted">{row.label}</dt>
            <dd className="break-words font-medium">{row.value}</dd>
          </div>
        ))}
    </dl>
  );
}
