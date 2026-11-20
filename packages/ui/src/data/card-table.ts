/**
 * Class names for a list table that becomes a stack of cards below 1024 px, where its columns do
 * not fit (Team, Roles, Sellers, Offers, Products, Orders). The first cell is the card's title; a
 * `corner` cell (a status) sits beside it; every other cell is a `labelled` line that shows its
 * column name from `data-label` on the same line as its value (a 7rem label column on phones,
 * the DataRow label column --mp-size-data-label from 640 px), so a card stays short.
 *
 * The row Actions column is the last one: `actionsHead` and `actions` keep it in view (sticky at the end
 * edge) when the table scrolls sideways, and on a phone it is the card's "…" in the top corner, after
 * the `corner` status (the grid has a third column for it, so the two never overlap). It is
 * never one of the optional columns of the column picker.
 */
export const ROW_ACTIONS_COLUMN_ID = 'actions';

export const CARD_TABLE = {
  table: 'w-full text-start text-sm max-lg:block',
  head: 'bg-muted text-fg-muted max-lg:sr-only',
  body: 'divide-y divide-line-row max-lg:block',
  row: 'max-lg:grid max-lg:grid-cols-[minmax(0,1fr)_auto_auto] max-lg:items-start max-lg:gap-y-1 max-lg:p-4',
  cell: 'px-4 py-3 align-top max-lg:p-0 max-lg:pb-1 max-lg:pe-3',
  corner: 'px-4 py-3 align-top max-lg:col-start-2 max-lg:row-start-1 max-lg:p-0 max-lg:text-end',
  actionsHead: 'px-4 py-3 text-end font-medium lg:sticky lg:end-0 lg:z-10 lg:w-20 lg:bg-muted',
  actions:
    'px-4 py-3 text-end align-top max-lg:col-start-3 max-lg:row-start-1 max-lg:p-0 max-lg:ps-3 lg:sticky lg:end-0 lg:z-10 lg:w-20 lg:bg-surface',
  labelled:
    'px-4 py-3 align-top max-lg:col-span-full max-lg:grid max-lg:grid-cols-[minmax(0,7rem)_minmax(0,1fr)] max-lg:items-baseline max-lg:justify-items-start max-lg:gap-x-2 max-lg:[&>*]:col-start-2 max-lg:p-0 max-lg:before:text-fg-muted max-lg:before:content-[attr(data-label)] sm:max-lg:grid-cols-[var(--mp-size-data-label)_minmax(0,1fr)]',
} as const;
