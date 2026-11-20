'use client';

import { SuperTable, type MenuItem, type RowSelectionState, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { EmptyWord, ShortIdCell, TimeCell } from '../../sales/cells.tsx';
import { labelOr } from '../label.ts';
import { Stars } from '../stars.tsx';
import { StatusBadge } from '../status-badge.tsx';
import type { OptionalColumn } from './list-columns.ts';
import type { ModerationListRow } from './list-types.ts';

const EXCERPT = 140;
/** The words that name a row to a screen reader ("Actions for 1 star: Awful"). */
const NAME = 40;

/** The title and the start of the review, as one line of at most `max` characters. */
export function excerpt(row: Pick<ModerationListRow, 'title' | 'body'>, max = EXCERPT): string {
  const text = [row.title, row.body].filter((part) => part !== null && part !== '').join(' - ');
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : text;
}

/**
 * The reviews of one page, from one column definition (`SuperTable`): a box to select the row, the
 * review (its excerpt opens it), rating, status, open reports, submitted and the optional columns
 * the admin chose, and the row Actions menu last. From 1024 px a table; below it each review is a
 * card with labelled lines (the excerpt as its title, the status in its corner). Never the author.
 */
export function ModerationTable({
  rows,
  columns,
  zone,
  selection,
  empty,
  skeletonRows,
  actions,
  onOpen,
}: {
  readonly rows: readonly ModerationListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: ModerationListRow) => readonly MenuItem[];
  readonly onOpen: (row: ModerationListRow) => void;
}) {
  const t = useTranslations('reviews-moderation.list');
  const tm = useTranslations('reviews-moderation');

  const optional = (column: OptionalColumn, row: ModerationListRow): ReactNode => {
    switch (column) {
      case 'review-id':
        return <ShortIdCell id={row.id} />;
      case 'product-id':
        return (
          <a
            className="text-link underline"
            href={`/catalog/products/${encodeURIComponent(row.productId)}`}
            title={row.productId}
          >
            <ShortIdCell id={row.productId} />
          </a>
        );
      case 'offer-id':
        return <ShortIdCell id={row.offerId} />;
      case 'seller-id':
        return <ShortIdCell id={row.sellerId} />;
      case 'locale':
        return row.locale;
      case 'edited':
        return <TimeCell at={row.editedAt} zone={zone} empty={t('not-edited')} />;
      case 'signals':
        return row.signalCodes.length === 0 ? (
          <EmptyWord>{t('none')}</EmptyWord>
        ) : (
          row.signalCodes.map((code) => labelOr(tm, `signal.${code}`, code)).join(', ')
        );
    }
  };

  const defs: SuperColumn<ModerationListRow>[] = [
    {
      id: 'review',
      header: t('col.review'),
      primary: true,
      cell: (row) => {
        const text = excerpt(row);
        return (
          <button
            type="button"
            className="text-start font-medium wrap-anywhere text-link underline lg:max-w-md"
            onClick={() => onOpen(row)}
          >
            {text === '' ? tm('no-text') : text}
          </button>
        );
      },
    },
    { id: 'rating', header: t('col.rating'), cell: (row) => <Stars rating={row.rating} /> },
    {
      id: 'status',
      header: t('col.status'),
      corner: true,
      cell: (row) => <StatusBadge status={row.status} />,
    },
    {
      id: 'reports',
      header: t('col.reports'),
      cell: (row) =>
        row.openReports === 0 ? (
          <EmptyWord>{t('none')}</EmptyWord>
        ) : (
          tm('open-reports', { count: row.openReports })
        ),
    },
    {
      id: 'submitted',
      header: t('col.submitted'),
      skeleton: 'date',
      cell: (row) => <TimeCell at={row.createdAt} zone={zone} />,
    },
    ...columns.map((column): SuperColumn<ModerationListRow> => ({
      id: column,
      header: t(`col.${column}`),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<ModerationListRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.id}
      rowName={(row) => {
        const text = excerpt(row, NAME);
        return t('row-name', { rating: row.rating, text: text === '' ? tm('no-text') : text });
      }}
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
