'use client';

import { SuperTable, type MenuItem, type RowSelectionState, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';
import { ShortIdCell, TimeCell } from '../../sales/cells.tsx';
import { shortId } from '../../shared/short-id.ts';
import type { OptionalColumn } from './list-types.ts';
import type { ListRow } from './types.ts';

/** The row actions this panel knows, in the order the Actions menu shows them. */
const ROW_ACTIONS = ['open', 'answer'] as const;

/**
 * The Actions menu of a request row: exactly the actions the row's `actions` array names (the
 * server decides per caller), in a fixed order; an id this panel does not know is ignored. Both go
 * to the request's page: Open to its top, Answer to the answer form on it (the answer itself
 * checks the edit permission, the version and the state again).
 */
export function useRequestRowActions(): (row: ListRow) => readonly MenuItem[] {
  const t = useTranslations('certificates.requests.actions');
  const router = useRouter();
  return (row) =>
    ROW_ACTIONS.filter((action) => row.actions.includes(action)).map((action) => ({
      id: action,
      label: t(action),
      onSelect: () =>
        router.push(
          `/certificates/issuer-requests/${encodeURIComponent(row.issuerRequestId)}${action === 'answer' ? '#rq-answer' : ''}`,
        ),
    }));
}

/**
 * The open requests of one page, from one column definition (`SuperTable`): a box to select the
 * row, the seller (one link to the request), the type, when it was submitted, then the columns the
 * admin chose, and the row Actions menu last. From 1024 px a table; below it each request is a
 * card with labelled lines. A seller that is not approved yet shows the fallback word and its short
 * id. Times are in `zone`, which the page names once.
 */
export function RequestsTable({
  rows,
  columns,
  typeNames,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly ListRow[];
  readonly columns: readonly OptionalColumn[];
  /** Type code to name; a code without a name is shown as it is. */
  readonly typeNames: Readonly<Record<string, string>>;
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  /** The first load: this many skeleton rows in place of `rows` and `empty`. */
  readonly skeletonRows?: number;
  /** The Actions menu of a row; a row with no items has none. */
  readonly actions: (row: ListRow) => readonly MenuItem[];
}) {
  const t = useTranslations('certificates.requests');
  const content = (column: OptionalColumn, row: ListRow): ReactNode => {
    switch (column) {
      case 'documents':
        return <span className="tabular-nums">{row.documentCount}</span>;
      case 'request-id':
        return <ShortIdCell id={row.issuerRequestId} />;
      case 'seller-id':
        return <ShortIdCell id={row.sellerId} />;
    }
  };
  const defs: SuperColumn<ListRow>[] = [
    {
      id: 'seller',
      header: t('col.seller'),
      primary: true,
      cell: (row) => (
        <>
          <a
            className="font-medium wrap-anywhere text-link underline"
            href={`/certificates/issuer-requests/${encodeURIComponent(row.issuerRequestId)}`}
          >
            {row.storeName === null ? t('seller-fallback') : row.storeName}
          </a>
          <span className="block text-xs text-fg-muted">
            {t('seller-id', { id: shortId(row.sellerId) })}
          </span>
        </>
      ),
    },
    {
      id: 'type',
      header: t('col.type'),
      cell: (row) => typeNames[row.typeCode] ?? row.typeCode,
    },
    {
      id: 'submitted',
      header: t('col.submitted'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.createdAt} zone={zone} />,
    },
    ...columns.map((column): SuperColumn<ListRow> => ({
      id: column,
      header: t(`col.${column}`),
      numeric: column === 'documents',
      cell: (row) => content(column, row),
    })),
  ];
  return (
    <SuperTable<ListRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.issuerRequestId}
      rowName={(row) => t('row-name', { id: shortId(row.issuerRequestId) })}
      columns={defs}
      selection={{
        state: selection,
        labels: {
          page: t('select.page'),
          pageShort: t('select.page-short'),
          row: (name) => t('select.row', { name }),
        },
      }}
      actions={{
        header: t('actions.header'),
        label: (name) => t('actions.for', { name }),
        items: actions,
      }}
      empty={empty}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass={defs.length > 5 ? 'lg:min-w-360' : 'lg:min-w-300'}
    />
  );
}
