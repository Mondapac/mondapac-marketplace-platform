'use client';

import type { ReactNode } from 'react';
import { SkeletonRows } from '../data/skeleton.tsx';
import { Banner } from '../form/banner.tsx';
import { Button } from '../form/button.tsx';
import { SearchField } from '../form/search-field.tsx';
import type { IconName } from '../icon/icon.tsx';
import { Popover, type PopoverProps } from '../overlay/popover.tsx';
import { FilterChipRow, type FilterChipRowProps } from './filter-chip-row.tsx';
import { ListPagination, type ListPaginationProps } from './list-pagination.tsx';
import { ListViewsBar, type ListViewsBarProps } from './list-views-bar.tsx';

export interface SuperListTool {
  readonly label: string;
  readonly icon?: IconName;
  readonly count?: number;
  readonly width?: PopoverProps['width'];
  /** The panel (a `ListFilterPanel`, `ListSortPanel` or `ListColumnsPanel` with the page's words). */
  readonly panel: PopoverProps['children'];
}

export interface SuperListProps {
  /** Above the tabs: what the list holds in words, then the bulk action menu and page actions. */
  readonly heading: { readonly subtitle: string; readonly actions?: ReactNode };
  /** Built-in tabs with their counts, then the saved filters, and "Manage filters…". */
  readonly views: ListViewsBarProps;
  /** Left out for a list its API cannot search (a customer's activity): no search box. */
  readonly search?: {
    readonly label: string;
    readonly placeholder: string;
    readonly value: string;
    readonly maxLength: number;
    /** What the search matches, read with the field (the placeholder is only a hint). */
    readonly help?: string;
    readonly onChange: (value: string) => void;
    /** Enter searches at once, without the typing pause. */
    readonly onSubmit: (value: string) => void;
  };
  readonly filter?: SuperListTool;
  readonly sort?: SuperListTool;
  readonly columns?: SuperListTool;
  /** "Sorted by Name, A to Z". */
  readonly sortedLine?: string;
  /** The chips and their buttons; null while nothing is filtered and nothing can be saved. */
  readonly chips: FilterChipRowProps | null;
  /** The list could not load: the banner, with Retry when trying again can help. */
  readonly failure: {
    readonly title?: string;
    readonly message: string;
    readonly retry?: { readonly label: string; readonly onClick: () => void };
  } | null;
  readonly loading: boolean;
  readonly loadingLabel: string;
  /** A first answer is in; the table shows (dimmed while the next one loads). */
  readonly ready: boolean;
  /** A `SuperTable`, with its empty state inside. */
  readonly table: ReactNode;
  /** The footer; null before the first answer or when there are no rows. */
  readonly pagination: ListPaginationProps | null;
  /** The save and manage filter dialogs, and anything else the page opens. */
  readonly dialogs?: ReactNode;
}

const TOOL_ICON = { filter: 'sliders', sort: 'arrow-down', columns: 'columns' } as const;

function Tool({
  tool,
  kind,
}: {
  readonly tool: SuperListTool;
  readonly kind: keyof typeof TOOL_ICON;
}) {
  return (
    <Popover
      label={tool.label}
      icon={tool.icon ?? TOOL_ICON[kind]}
      count={tool.count ?? 0}
      width={tool.width ?? (kind === 'filter' ? 'lg' : kind === 'sort' ? 'sm' : 'md')}
    >
      {tool.panel}
    </Popover>
  );
}

/**
 * One list for every table over 50 rows ("super list"): heading and bulk actions, view tabs with
 * saved filters, search, the filter, sort and column panels, the chips, the table, and the footer
 * that follows the Market's List paging setting. Pages describe their list with these props and a
 * `SuperTable`; the layout, spacing, states and phone behaviour live here, once. State (the query,
 * the saved tab rule) lives in `useSuperListQuery`.
 */
export function SuperList({
  heading,
  views,
  search,
  filter,
  sort,
  columns,
  sortedLine,
  chips,
  failure,
  loading,
  loadingLabel,
  ready,
  table,
  pagination,
  dialogs,
}: SuperListProps) {
  const hasTools = filter !== undefined || sort !== undefined || columns !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <p className="min-w-0 text-sm text-fg-muted">{heading.subtitle}</p>
        {heading.actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">{heading.actions}</div>
        )}
      </div>
      <ListViewsBar {...views} />
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {search === undefined ? null : (
          <SearchField
            label={search.label}
            placeholder={search.placeholder}
            value={search.value}
            maxLength={search.maxLength}
            {...(search.help === undefined ? {} : { help: search.help })}
            className="w-full min-w-0 sm:min-w-64 sm:max-w-110 sm:flex-1"
            onChange={(event) => search.onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') search.onSubmit(search.value.trim());
            }}
          />
        )}
        {hasTools ? (
          <div className="flex items-center gap-2">
            {filter === undefined ? null : <Tool tool={filter} kind="filter" />}
            {sort === undefined ? null : <Tool tool={sort} kind="sort" />}
            {columns === undefined ? null : <Tool tool={columns} kind="columns" />}
          </div>
        ) : null}
        {sortedLine === undefined ? null : (
          <p className="text-sm text-fg-muted sm:ms-auto">{sortedLine}</p>
        )}
      </div>
      {chips === null ? null : <FilterChipRow {...chips} />}
      {failure === null ? null : (
        <Banner tone="critical" {...(failure.title === undefined ? {} : { title: failure.title })}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{failure.message}</span>
            {failure.retry === undefined ? null : (
              <Button variant="secondary" onClick={failure.retry.onClick}>
                {failure.retry.label}
              </Button>
            )}
          </div>
        </Banner>
      )}
      {loading && (!ready || failure !== null) ? (
        <SkeletonRows label={loadingLabel} rows={4} />
      ) : null}
      {ready && failure === null ? (
        <div className={loading ? 'opacity-60' : undefined} aria-busy={loading}>
          {table}
        </div>
      ) : null}
      {ready && failure === null && pagination !== null ? <ListPagination {...pagination} /> : null}
      {dialogs}
    </div>
  );
}
