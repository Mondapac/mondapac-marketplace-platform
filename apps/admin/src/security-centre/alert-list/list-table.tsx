'use client';

import { SuperTable, type MenuItem, type RowSelectionState, type SuperColumn } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { ShortIdCell, TimeCell } from '../../sales/cells.tsx';
import { ResponseText, SeverityBadge, StateBadge, useAgo } from '../parts.tsx';
import type { OptionalColumn } from './list-columns.ts';
import type { AlertListRow } from './list-types.ts';

/**
 * The alerts of one page, from one column definition (`SuperTable`): a box to select the row, the
 * alert (its title opens its page), severity, key, events, opened, state and response, the optional
 * columns the admin chose, and the row Actions menu last. From 1024 px a table; below it each alert
 * is a card with labelled lines (the title first, the severity in its corner). A live S1 alert has
 * a red bar at its start. An address key is masked by the API.
 */
export function AlertTable({
  rows,
  columns,
  zone,
  now,
  noRoster,
  selection,
  empty,
  skeletonRows,
  actions,
}: {
  readonly rows: readonly AlertListRow[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  /** The page's clock, for "5 min ago" and the S1 timer. */
  readonly now: number;
  readonly noRoster: boolean;
  readonly selection: RowSelectionState;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly actions: (row: AlertListRow) => readonly MenuItem[];
}) {
  const t = useTranslations('security-centre.list');
  const tc = useTranslations('security-centre');
  const ago = useAgo();

  const optional = (column: OptionalColumn, row: AlertListRow): ReactNode => {
    switch (column) {
      case 'alert-id':
        return <ShortIdCell id={row.id} />;
      case 'first-event':
        return <TimeCell at={row.firstEventAt} zone={zone} />;
      case 'last-event':
        return <TimeCell at={row.lastEventAt} zone={zone} />;
      case 'acknowledged':
        return <TimeCell at={row.acknowledgedAt} zone={zone} empty={t('not-yet')} />;
      case 'resolved':
        return <TimeCell at={row.resolvedAt} zone={zone} empty={t('not-yet')} />;
    }
  };

  const defs: SuperColumn<AlertListRow>[] = [
    {
      id: 'alert',
      header: t('col.alert'),
      primary: true,
      cell: (row) => (
        <>
          <a
            className="font-medium text-link underline lg:max-w-md"
            href={`/security/alerts/${encodeURIComponent(row.id)}`}
          >
            {row.title}
          </a>
          <div className="font-mono text-xs text-fg-muted">{row.rule}</div>
        </>
      ),
    },
    {
      id: 'severity',
      header: t('col.severity'),
      corner: true,
      cell: (row) => <SeverityBadge severity={row.severity} />,
    },
    {
      id: 'key',
      header: t('col.key'),
      cell: (row) => (
        <span className="break-all">
          <span className="text-fg-muted">{tc(`key.${row.keyType}`)}: </span>
          <span className="font-mono">{row.keyLabel}</span>
        </span>
      ),
    },
    {
      id: 'events',
      header: t('col.events'),
      cell: (row) => <span className="tabular-nums">{row.eventCount}</span>,
    },
    {
      id: 'opened',
      header: t('col.opened'),
      skeleton: 'date',
      cell: (row) => (
        <time dateTime={row.openedAt} className="whitespace-nowrap">
          {ago(row.openedAt, now)}
          <span className="sr-only">
            {' '}
            (<TimeCell at={row.openedAt} zone={zone} />)
          </span>
        </time>
      ),
    },
    { id: 'state', header: t('col.state'), cell: (row) => <StateBadge state={row.state} /> },
    {
      id: 'response',
      header: t('col.response'),
      cell: (row) => <ResponseText alert={row} now={now} noRoster={noRoster} />,
    },
    ...columns.map((column): SuperColumn<AlertListRow> => ({
      id: column,
      header: t(`col.${column}`),
      cell: (row) => optional(column, row),
    })),
  ];

  return (
    <SuperTable<AlertListRow>
      caption={t('title')}
      rows={rows}
      rowId={(row) => row.id}
      rowName={(row) => row.title}
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
      minWidthClass={defs.length > 8 ? 'lg:min-w-360' : 'lg:min-w-300'}
    />
  );
}
