'use client';

import { Fragment, type KeyboardEvent, type ReactNode } from 'react';
import { CARD_TABLE } from '../data/card-table.ts';
import { SelectBox } from '../form/select-box.tsx';
import { Menu, type MenuItem } from '../overlay/menu.tsx';
import {
  ListRefreshBar,
  ListRefreshHeadRow,
  ListSkeletonRows,
  type ListSkeletonCell,
  type ListSkeletonKind,
} from './list-skeleton.tsx';
import type { RowSelectionState } from './use-row-selection.ts';

const SELECT_CELL =
  'w-14 px-4 py-3 align-middle max-lg:absolute max-lg:start-4 max-lg:top-4 max-lg:w-auto max-lg:p-0';

export interface SuperColumn<Row> {
  readonly id: string;
  /** The column header; on a phone it is the line's label. */
  readonly header: string;
  readonly cell: (row: Row) => ReactNode;
  /** A number: header and cells end together, with tabular figures from 1024 px. */
  readonly numeric?: boolean;
  /** The card's title cell on a phone (image and name); one column, the first. */
  readonly primary?: boolean;
  /** Sits beside the title on a phone (a status badge) instead of being a labelled line. */
  readonly corner?: boolean;
  /** Extra classes of the header cell, for example a minimum width. */
  readonly headClassName?: string;
  /** The placeholder shape while the first page loads; by default `thumb`/`title`, `number` or `text`. */
  readonly skeleton?: ListSkeletonKind;
}

export interface SuperTableSelectionLabels {
  /** The header box: "Select all on this page". */
  readonly page: string;
  /** The phone bar's label. */
  readonly pageShort: string;
  readonly row: (name: string) => string;
}

export interface SuperTableProps<Row> {
  /** The table's accessible name. */
  readonly caption: string;
  readonly rows: readonly Row[];
  readonly rowId: (row: Row) => string;
  /** The row's name for the labels of its select box and Actions menu. */
  readonly rowName: (row: Row) => string;
  readonly columns: readonly SuperColumn<Row>[];
  readonly selection?: {
    readonly state: RowSelectionState;
    readonly labels: SuperTableSelectionLabels;
  };
  /**
   * The row Actions column: the last column, sticky at the end edge when the table scrolls
   * sideways, a "…" in the corner of the card on a phone. No list shows buttons inside its rows:
   * every row action goes in this menu. A row with no items has no menu.
   */
  readonly actions?: {
    readonly header: string;
    readonly label: (name: string) => string;
    readonly items: (row: Row) => readonly MenuItem[];
  };
  /**
   * Content shown in a full-width row right under a row (an opened row of sub-rows, such as the
   * sizes of an Offer); null for none. `rowId` + "-more" is its id, for an `aria-controls`.
   */
  readonly expanded?: (row: Row) => ReactNode;
  /** Keys pressed in the table's fields, such as Enter moving down a column of fields. */
  readonly onKeyDown?: (event: KeyboardEvent<HTMLTableElement>) => void;
  /** Shown in place of the rows when there are none, under the column headers. */
  readonly empty?: ReactNode;
  /**
   * The first load (panel loading L2): this many skeleton rows in the shape of the columns, under
   * the real header, in place of `rows` and `empty`.
   */
  readonly skeletonRows?: number;
  /** Class that sets the table's minimum width from 1024 px (`lg:min-w-240`). */
  readonly minWidthClass?: string;
}

/**
 * The table of a super list, from one column definition: an optional select box column, the
 * columns, and the row Actions column. From 1024 px a table; below it each row is a card (title,
 * corner, labelled lines). A text column starts where its header starts; a number column ends
 * with its header.
 */
export function SuperTable<Row>({
  caption,
  rows,
  rowId,
  rowName,
  columns,
  selection,
  actions,
  empty,
  expanded,
  onKeyDown,
  skeletonRows,
  minWidthClass = 'lg:min-w-160',
}: SuperTableProps<Row>) {
  const { cell, corner, labelled } = CARD_TABLE;
  const state = selection?.state;
  const isOn = (row: Row) =>
    state !== undefined && (state.allMatching || state.selected.has(rowId(row)));
  const onPage = rows.filter(isOn).length;
  const allOnPage = rows.length > 0 && onPage === rows.length;
  const someOnPage = onPage > 0 && !allOnPage;
  const count =
    columns.length + (selection === undefined ? 0 : 1) + (actions === undefined ? 0 : 1);
  const loading = skeletonRows !== undefined;
  // The classes of a real cell, shared with its skeleton cell so widths and the card layout match.
  const cellClass = (column: SuperColumn<Row>): string =>
    column.primary === true
      ? `${cell} ${selection === undefined ? '' : 'max-lg:ps-8'} ${column.headClassName ?? ''}`
      : column.corner === true
        ? // With an Actions menu the corner is taken: the status moves under the title.
          actions === undefined
          ? corner
          : 'px-4 py-3 align-top max-lg:col-span-2 max-lg:p-0'
        : `${labelled} ${column.numeric === true ? 'lg:text-end lg:tabular-nums' : ''}`;
  const skeletonCells: readonly ListSkeletonCell[] = [
    ...(selection === undefined ? [] : [{ kind: 'select' as const, className: SELECT_CELL }]),
    ...columns.map((column): ListSkeletonCell => ({
      kind:
        column.skeleton ??
        (column.primary === true
          ? 'title'
          : column.numeric === true
            ? 'number'
            : column.corner === true
              ? 'status'
              : 'text'),
      className: cellClass(column),
      ...(column.primary === true || column.corner === true ? {} : { label: column.header }),
    })),
    ...(actions === undefined ? [] : [{ kind: 'text' as const, className: CARD_TABLE.actions }]),
  ];

  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      {/* The header is hidden below 1024 px, so a phone gets its select-all box in a bar of its own. */}
      {selection !== undefined && state !== undefined && (loading || rows.length > 0) ? (
        <label className="relative flex cursor-pointer items-center gap-3 border-b border-line-row bg-muted px-4 py-3 text-sm text-fg-muted lg:hidden">
          <SelectBox
            label={selection.labels.pageShort}
            checked={allOnPage}
            indeterminate={someOnPage}
            disabled={loading}
            onChange={(event) => state.togglePage(event.target.checked)}
          />
          <span className="ps-1">{selection.labels.pageShort}</span>
          {/* Cards: the refresh bar runs under this bar, which stands in for the header. */}
          <span className="absolute inset-x-0 top-full">
            <ListRefreshBar />
          </span>
        </label>
      ) : null}
      <table className={`${CARD_TABLE.table} ${minWidthClass}`} onKeyDown={onKeyDown}>
        <caption className="sr-only">{caption}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            {selection === undefined || state === undefined ? null : (
              <th scope="col" className="w-14 px-4 py-3 align-middle font-medium">
                <SelectBox
                  label={selection.labels.page}
                  checked={allOnPage}
                  indeterminate={someOnPage}
                  disabled={loading || rows.length === 0}
                  onChange={(event) => state.togglePage(event.target.checked)}
                />
              </th>
            )}
            {columns.map((column) => (
              <th
                key={column.id}
                scope="col"
                className={`px-4 py-3 font-medium ${column.primary === true ? '' : 'whitespace-nowrap'} ${column.numeric === true ? 'text-end' : ''} ${column.headClassName ?? ''}`}
              >
                {column.header}
              </th>
            ))}
            {actions === undefined ? null : (
              <th scope="col" className={CARD_TABLE.actionsHead}>
                {actions.header}
              </th>
            )}
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
          {(loading ? [] : rows).map((row) => {
            const id = rowId(row);
            const name = rowName(row);
            const items = actions?.items(row) ?? [];
            const more = expanded?.(row) ?? null;
            return (
              <Fragment key={id}>
                <tr
                  className={`${CARD_TABLE.row} max-lg:relative ${isOn(row) ? 'bg-selected' : ''}`}
                >
                  {selection === undefined || state === undefined ? null : (
                    <td className={SELECT_CELL}>
                      <SelectBox
                        label={selection.labels.row(name)}
                        checked={isOn(row)}
                        disabled={state.full && !isOn(row)}
                        onChange={() => state.toggleRow(id)}
                      />
                    </td>
                  )}
                  {columns.map((column) => (
                    <td
                      key={column.id}
                      className={cellClass(column)}
                      {...(column.primary === true || column.corner === true
                        ? {}
                        : { 'data-label': column.header })}
                    >
                      {column.cell(row)}
                    </td>
                  ))}
                  {actions === undefined ? null : (
                    <td className={CARD_TABLE.actions}>
                      {items.length === 0 ? null : (
                        <Menu label={actions.label(name)} items={[...items]} />
                      )}
                    </td>
                  )}
                </tr>
                {more === null ? null : (
                  <tr id={`${id}-more`} className="bg-muted max-lg:block">
                    <td colSpan={count} className="px-4 py-3 max-lg:block">
                      {more}
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
