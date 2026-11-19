'use client';

import {
  CARD_TABLE,
  ListRefreshBar,
  ListRefreshHeadRow,
  ListSkeletonRows,
  Menu,
  SelectBox,
  relativeTime,
  toast,
  type ListSkeletonCell,
  type MenuItem,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { formatInstantInZone, shortDateInZone } from '../shared/format.ts';
import {
  AreaBadge,
  OverdueText,
  RiskBadge,
  StatusBadges,
  useKindTitle,
  usePersonName,
} from './request-parts.tsx';
import {
  requestPath,
  subjectHref,
  type OptionalColumn,
  type RowAction,
  type SystemRequest,
} from './types.ts';

const SELECT_CELL =
  'w-14 px-4 py-3 align-middle max-lg:absolute max-lg:start-4 max-lg:top-4 max-lg:w-auto max-lg:p-0';

export interface QueueSelection {
  readonly selected: ReadonlySet<string>;
  readonly allMatching: boolean;
  readonly full: boolean;
  readonly onToggle: (id: string) => void;
  readonly onTogglePage: (checked: boolean) => void;
}

/** The row menu: exactly the actions the API listed for the caller, never another. */
export function useRowMenu(
  onDecide: (row: SystemRequest, action: 'approve' | 'reject' | 'withdraw') => void,
): (row: SystemRequest) => readonly MenuItem[] {
  const t = useTranslations('system-requests');
  return (row) =>
    row.actions.flatMap((action: RowAction): MenuItem[] => {
      switch (action) {
        case 'open':
          return [
            {
              id: 'open',
              label: t('action.open'),
              onSelect: () => window.location.assign(requestPath(row.id)),
            },
          ];
        case 'copy-link':
          return [
            {
              id: 'copy-link',
              label: t('action.copy-link'),
              onSelect: () => {
                const url = `${window.location.origin}${requestPath(row.id)}`;
                void navigator.clipboard
                  ?.writeText(url)
                  .then(() => toast.success(t('link-copied')))
                  .catch(() => toast.error(t('link-not-copied')));
              },
            },
          ];
        case 'approve':
          return [
            { id: 'approve', label: t('action.approve'), onSelect: () => onDecide(row, 'approve') },
          ];
        case 'reject':
          return [
            {
              id: 'reject',
              label: t('action.reject'),
              tone: 'critical',
              onSelect: () => onDecide(row, 'reject'),
            },
          ];
        case 'withdraw':
          return [
            {
              id: 'withdraw',
              label: t('action.withdraw'),
              tone: 'critical',
              onSelect: () => onDecide(row, 'withdraw'),
            },
          ];
        default:
          return [];
      }
    });
}

/**
 * The rows of one page. From 1024 px a table: a box to select, the request (number as the link,
 * the note under it), area, risk and status, then the optional columns the admin chose, and a
 * kebab menu. Below it each row is a card (CARD_TABLE).
 */
export function QueueTable({
  rows,
  columns,
  zone,
  accountId,
  selection,
  empty,
  skeletonRows,
  menuOf,
}: {
  readonly rows: readonly SystemRequest[];
  readonly columns: readonly OptionalColumn[];
  readonly zone: string;
  readonly accountId: string;
  readonly selection: QueueSelection;
  readonly empty?: ReactNode;
  readonly skeletonRows?: number;
  readonly menuOf: (row: SystemRequest) => readonly MenuItem[];
}) {
  const t = useTranslations('system-requests');
  const locale = useLocale();
  const kindTitle = useKindTitle();
  const person = usePersonName(accountId);
  const { cell, corner, labelled } = CARD_TABLE;
  const count = 7 + columns.length;
  const isOn = (row: SystemRequest) => selection.allMatching || selection.selected.has(row.id);
  const onPage = rows.filter(isOn).length;
  const allOnPage = rows.length > 0 && onPage === rows.length;
  const someOnPage = onPage > 0 && !allOnPage;
  const loading = skeletonRows !== undefined;

  const skeletonCells: readonly ListSkeletonCell[] = [
    { kind: 'select', className: SELECT_CELL },
    { kind: 'title', className: `${cell} lg:min-w-72 max-lg:ps-8` },
    { kind: 'status', className: `${labelled}`, label: t('col.area') },
    { kind: 'status', className: `${labelled}`, label: t('col.risk') },
    { kind: 'status', className: corner },
    ...columns.map((column): ListSkeletonCell => ({
      kind:
        column === 'subject' || column === 'requestedBy' || column === 'decidedBy'
          ? 'text'
          : 'date',
      className: labelled,
      label: t(`col.${column}`),
    })),
  ];

  const when = (iso: string | null) =>
    iso === null ? (
      <span className="text-fg-muted">{t('none')}</span>
    ) : (
      <time
        dateTime={iso}
        title={formatInstantInZone(iso, locale, zone)}
        className="whitespace-nowrap"
      >
        {relativeTime(iso, locale)}
      </time>
    );

  const content = (column: OptionalColumn, row: SystemRequest): ReactNode => {
    switch (column) {
      case 'subject': {
        const href = subjectHref(row.subjectKind, row.subjectRef);
        const name = row.subjectLabel ?? row.subjectRef;
        return (
          <span className="break-words">
            <span className="block text-fg">{kindTitle(row.subjectKind)}</span>
            {href === null ? (
              <span className="block text-xs text-fg-muted">{name}</span>
            ) : (
              <a href={href} className="block text-xs text-link underline">
                {name}
              </a>
            )}
          </span>
        );
      }
      case 'requestedBy':
        return person(row.requestedBy, row.requestedByName);
      case 'applied':
        return when(row.appliedAt);
      case 'due':
        return row.status === 'open' ? (
          <span className="block">
            <span className="whitespace-nowrap">
              {shortDateInZone(row.reviewDueAt, locale, zone)}
            </span>
            {row.overdue ? (
              <span className="block text-xs">
                <OverdueText request={row} zone={zone} />
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-fg-muted">{t('none')}</span>
        );
      case 'decidedBy':
        return row.decidedBy === null ? (
          <span className="text-fg-muted">{t('none')}</span>
        ) : (
          person(row.decidedBy, row.decidedByName)
        );
      case 'decided':
        return row.decidedAt === null ? (
          <span className="text-fg-muted">{t('none')}</span>
        ) : (
          <span className="whitespace-nowrap">{shortDateInZone(row.decidedAt, locale, zone)}</span>
        );
      case 'comments':
        return String(row.commentCount);
    }
  };

  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      {loading || rows.length > 0 ? (
        <label className="relative flex cursor-pointer items-center gap-3 border-b border-line-row bg-muted px-4 py-3 text-sm text-fg-muted lg:hidden">
          <SelectBox
            label={t('select.page-short')}
            checked={allOnPage}
            indeterminate={someOnPage}
            disabled={loading}
            onChange={(event) => selection.onTogglePage(event.target.checked)}
          />
          <span className="ps-1">{t('select.page-short')}</span>
          <span className="absolute inset-x-0 top-full">
            <ListRefreshBar />
          </span>
        </label>
      ) : null}
      <table className={`${CARD_TABLE.table} lg:min-w-300`}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="w-14 px-4 py-3 align-middle font-medium">
              <SelectBox
                label={t('select.page')}
                checked={allOnPage}
                indeterminate={someOnPage}
                disabled={loading || rows.length === 0}
                onChange={(event) => selection.onTogglePage(event.target.checked)}
              />
            </th>
            <th scope="col" className="px-4 py-3 font-medium lg:min-w-72">
              {t('col.request')}
            </th>
            <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
              {t('col.area')}
            </th>
            <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
              {t('col.risk')}
            </th>
            <th scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
              {t('col.status')}
            </th>
            {columns.map((column) => (
              <th key={column} scope="col" className="whitespace-nowrap px-4 py-3 font-medium">
                {t(`col.${column}`)}
              </th>
            ))}
            <th scope="col" className="w-12 px-4 py-3 font-medium">
              <span className="sr-only">{t('col.actions')}</span>
            </th>
          </tr>
          <ListRefreshHeadRow columns={count} />
        </thead>
        <tbody className={CARD_TABLE.body}>
          {loading ? <ListSkeletonRows cells={skeletonCells} rows={skeletonRows} /> : null}
          {!loading && rows.length === 0 && empty !== undefined ? (
            <tr className="max-lg:block">
              <td colSpan={count} className="max-lg:block">
                {empty}
              </td>
            </tr>
          ) : null}
          {(loading ? [] : rows).map((row) => (
            <tr
              key={row.id}
              className={`${CARD_TABLE.row} max-lg:relative ${isOn(row) ? 'bg-selected' : ''}`}
            >
              <td className={SELECT_CELL}>
                <SelectBox
                  label={t('select.row', { number: row.displayNumber })}
                  checked={isOn(row)}
                  disabled={selection.full && !isOn(row)}
                  onChange={() => selection.onToggle(row.id)}
                />
              </td>
              <th
                scope="row"
                className={`${cell} text-start font-normal lg:min-w-72 max-lg:contents`}
              >
                <a
                  href={requestPath(row.id)}
                  className="font-medium text-link underline max-lg:inline-flex max-lg:min-h-11 max-lg:items-center max-lg:self-start max-lg:ps-8"
                >
                  {row.displayNumber}
                </a>
                <span className="mt-0.5 block break-words text-fg-muted max-lg:col-span-2 max-lg:mt-0 lg:max-w-md lg:truncate">
                  {row.note}
                </span>
              </th>
              <td className={`${labelled} max-lg:hidden`}>
                <AreaBadge area={row.area} />
              </td>
              <td className={`${labelled} max-lg:hidden`}>
                <RiskBadge risk={row.risk} />
              </td>
              <td className={`${corner} max-lg:pe-14`}>
                <StatusBadges request={row} />
              </td>
              {/* On a phone the area and risk badges share one line under the note. */}
              <td className="hidden max-lg:col-span-2 max-lg:flex max-lg:gap-2 max-lg:p-0">
                <AreaBadge area={row.area} />
                <RiskBadge risk={row.risk} />
              </td>
              {columns.map((column) => (
                <td key={column} className={labelled} data-label={t(`col.${column}`)}>
                  {content(column, row)}
                </td>
              ))}
              <td className="px-4 py-3 align-top max-lg:absolute max-lg:end-2 max-lg:top-2 max-lg:p-0">
                {menuOf(row).length > 0 ? (
                  <Menu
                    label={t('row-actions', { number: row.displayNumber })}
                    items={menuOf(row)}
                  />
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
