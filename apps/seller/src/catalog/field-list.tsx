import { DataList } from '@mondapac/ui';
import type { ReactNode } from 'react';

/** A labelled list of facts (the shared DataList); a row whose value is null is left out. */
export function FieldList({
  rows,
}: {
  readonly rows: readonly { readonly label: string; readonly value: ReactNode | null }[];
}) {
  return (
    <DataList
      rows={rows.filter((row) => row.value !== null)}
      // Never shown: rows without a value are left out.
      missing=""
    />
  );
}
