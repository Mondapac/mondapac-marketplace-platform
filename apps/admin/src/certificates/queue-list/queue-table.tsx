'use client';

import {
  Badge,
  SuperTable,
  type MenuItem,
  type RowSelectionState,
  type SuperColumn,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { ShortIdCell, TimeCell } from '../../sales/cells.tsx';
import { shortId } from '../../shared/short-id.ts';
import type { OptionalColumn } from './queue-columns.ts';
import type { QueueListRow } from './queue-types.ts';

const KIND_TONE = { initial: 'neutral', resubmission: 'attention', renewal: 'info' } as const;
const kindTone = (kind: string) =>
  kind === 'resubmission' || kind === 'renewal' ? KIND_TONE[kind] : KIND_TONE.initial;

/**
 * The waiting submissions of one page, from one column definition (`SuperTable`): a box to select
 * the row, the seller, then the type, kind, issuer, waiting since and the optional columns the
 * admin chose, and the row Actions menu last. From 1024 px a table; below it each submission is a
 * card with labelled lines (the seller as its title, the kind in its corner). The type shows its
 * name when the reader may view types, otherwise its code.
 */
export function QueueTable({
  rows,
  columns,
  typeNames,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly QueueListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly typeNames: ReadonlyMap<string, string>;
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: QueueListRow) => readonly MenuItem[];
}) {
  const t = useTranslations('certificates.queue');

  const optional = (column: OptionalColumn, row: QueueListRow): ReactNode => {
    switch (column) {
      case 'submission-no':
        return t('submission-no', { n: row.submissionNo });
      case 'certificate-id':
        return <ShortIdCell id={row.certificateId} />;
      case 'submission-id':
        return <ShortIdCell id={row.submissionId} />;
      case 'seller-id':
        return <ShortIdCell id={row.sellerId} />;
    }
  };

  const defs: SuperColumn<QueueListRow>[] = [
    {
      id: 'seller',
      header: t('col.seller'),
      primary: true,
      cell: (row) => (
        <>
          <a
            className="font-medium wrap-anywhere text-link underline"
            href={`/sellers/${encodeURIComponent(row.sellerId)}`}
            title={row.sellerId}
          >
            {row.storeName ?? t('seller-fallback')}
            <span className="sr-only">{t('seller-id-sr', { id: shortId(row.sellerId) })}</span>
          </a>
          <span className="block text-xs text-fg-muted">{shortId(row.sellerId)}</span>
        </>
      ),
    },
    {
      id: 'type',
      header: t('col.type'),
      cell: (row) => typeNames.get(row.typeCode) ?? row.typeCode,
    },
    {
      id: 'kind',
      header: t('col.kind'),
      corner: true,
      cell: (row) => <Badge tone={kindTone(row.kind)}>{t(`kind.${row.kind}`)}</Badge>,
    },
    {
      id: 'issuer',
      header: t('col.issuer'),
      cell: (row) => row.issuerName ?? <span className="text-fg-muted">{t('no-issuer')}</span>,
    },
    {
      id: 'waiting',
      header: t('col.waiting'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.submittedAt} zone={zone} />,
    },
    ...columns.map((column): SuperColumn<QueueListRow> => ({
      id: column,
      header: t(`col.${column}`),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<QueueListRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.certificateId}
      rowName={(row) => t('row-name', { store: row.storeName ?? t('seller-fallback') })}
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
        header: t('col.actions'),
        label: (name) => t('actions.for', { name }),
        items: actions,
      }}
      empty={empty}
      {...(skeletonRows === undefined ? {} : { skeletonRows })}
      minWidthClass={defs.length > 7 ? 'lg:min-w-360' : 'lg:min-w-300'}
    />
  );
}
