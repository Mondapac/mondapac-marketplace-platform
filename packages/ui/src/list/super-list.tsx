'use client';

import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Banner } from '../form/banner.tsx';
import { Button } from '../form/button.tsx';
import { LoadError } from '../form/load-error.tsx';
import { SearchField } from '../form/search-field.tsx';
import type { IconName } from '../icon/icon.tsx';
import { PAGE_ACTIONS_ID, PageHeader } from '../help/page-header.tsx';
import { Popover, type PopoverProps } from '../overlay/popover.tsx';
import { FilterChipRow, type FilterChipRowProps } from './filter-chip-row.tsx';
import { ListPagination, type ListPaginationProps } from './list-pagination.tsx';
import { ListLoadingStatus, ListRefreshing, type ListLoading } from './list-skeleton.tsx';
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
  readonly heading: {
    /**
     * The page's h1 row. A page list leaves it out when the page draws its own `PageHeader`: the
     * buttons then move into that row (the Orders layout) so no page can put them on a row of
     * their own. Give it only when the list draws the page's header itself.
     */
    readonly title?: string;
    /**
     * A list inside a record's tab or card, below a page header that is not this list's: its
     * buttons stay in the list's own row.
     */
    readonly embedded?: boolean;
    /**
     * A notice about the list (a truncation, what the list is based on), not a count: counts live
     * in the tabs. Shown as a muted line under the header row; empty or absent when none.
     */
    readonly subtitle?: string;
    /** A live-state label beside the title ("Live · every 30 s", "Default"). */
    readonly status?: string;
    readonly actions?: ReactNode;
  };
  /** A notice between the heading and the tabs (for example a view-only banner). */
  readonly notice?: ReactNode;
  /**
   * Built-in tabs with their counts, then the saved filters, and "Manage filters…". Left out by a
   * compact list inside a page's card (no views, no saved filters): no tab row.
   */
  readonly views?: ListViewsBarProps;
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
    /** The box lost focus (a page can then show a hint about what was typed). */
    readonly onBlur?: () => void;
    /** Sits right after the search box (a scope select, a hint line); the page owns its words. */
    readonly extra?: ReactNode;
  };
  readonly filter?: SuperListTool;
  readonly sort?: SuperListTool;
  readonly columns?: SuperListTool;
  /**
   * The tool buttons in place of `filter`, `sort` and `columns`, for a list whose phone layout
   * opens them in a sheet. Give it the whole `fieldset`, disabled while `status.skeleton` shows.
   */
  readonly toolbar?: ReactNode;
  /** "Sorted by Name, A to Z". */
  readonly sortedLine?: string;
  /** The chips and their buttons; null while nothing is filtered and nothing can be saved. */
  readonly chips: FilterChipRowProps | null;
  /**
   * The list could not load. After a first page, a banner above the rows (with Retry when trying
   * again can help); with `firstLoadError` the load error stands in place of the list.
   */
  readonly failure: {
    readonly title?: string;
    readonly message: string;
    readonly retry?: { readonly label: string; readonly onClick: () => void };
  } | null;
  /** No page has arrived and the load failed or stalled: the load error replaces the list. */
  readonly firstLoadError?: boolean;
  readonly loading: boolean;
  /** From `useListLoading(loading, ready)` (panel loading L2): skeleton rows first, dimmed rows after. */
  readonly status: ListLoading;
  readonly loadingLabel: string;
  readonly slowLabel: string;
  /** A first answer is in. */
  readonly ready: boolean;
  /** A `SuperTable`; give it `skeletonRows` while `status.skeleton` shows. */
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

/** The buttons of a list that sits under its page's own `PageHeader`: placed in that row. */
function PageRowActions({ children }: { readonly children: ReactNode }) {
  // Pending until the page's header is found: nothing is drawn in a row of its own meanwhile.
  const [target, setTarget] = useState<HTMLElement | null | 'none'>(null);
  useLayoutEffect(() => {
    setTarget(document.getElementById(PAGE_ACTIONS_ID) ?? 'none');
  }, []);
  if (target === null) return null;
  if (target === 'none') {
    return <div className="flex flex-wrap items-center justify-end gap-2">{children}</div>;
  }
  return createPortal(children, target);
}

function ListHeading({ heading }: { readonly heading: SuperListProps['heading'] }) {
  const note =
    heading.subtitle === undefined || heading.subtitle === '' ? null : (
      <p className="min-w-0 text-sm text-fg-muted">{heading.subtitle}</p>
    );
  if (heading.title !== undefined) {
    return (
      <div className="flex min-w-0 flex-col gap-1">
        <PageHeader
          title={heading.title}
          {...(heading.status === undefined ? {} : { status: heading.status })}
          {...(heading.actions === undefined ? {} : { actions: heading.actions })}
        />
        {note}
      </div>
    );
  }
  if (heading.embedded === true) {
    if (note === null && heading.actions === undefined) return null;
    return (
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">{note}</div>
        {heading.actions === undefined ? null : (
          <div className="flex flex-wrap items-center gap-2">{heading.actions}</div>
        )}
      </div>
    );
  }
  return (
    <>
      {heading.actions === undefined ? null : <PageRowActions>{heading.actions}</PageRowActions>}
      {note}
    </>
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
  notice,
  views,
  search,
  filter,
  sort,
  columns,
  toolbar,
  sortedLine,
  chips,
  failure,
  firstLoadError = false,
  loading,
  status,
  loadingLabel,
  slowLabel,
  ready,
  table,
  pagination,
  dialogs,
}: SuperListProps) {
  const skeleton = status.skeleton && failure === null;
  const hasTools = filter !== undefined || sort !== undefined || columns !== undefined;
  return (
    <div className="flex flex-col gap-4">
      <ListHeading heading={heading} />
      {notice}
      {views === undefined ? null : <ListViewsBar {...views} />}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {search === undefined ? null : (
          <>
            <SearchField
              label={search.label}
              placeholder={search.placeholder}
              value={search.value}
              maxLength={search.maxLength}
              {...(search.help === undefined ? {} : { help: search.help })}
              className="w-full min-w-0 sm:min-w-80 sm:max-w-110 sm:flex-1"
              onChange={(event) => search.onChange(event.target.value)}
              onBlur={search.onBlur}
              onKeyDown={(event) => {
                if (event.key === 'Enter') search.onSubmit(search.value.trim());
              }}
            />
            {search.extra}
          </>
        )}
        {/* The real toolbar shows while the first page loads, but cannot act on rows yet. */}
        {toolbar !== undefined ? toolbar : null}
        {toolbar === undefined && hasTools ? (
          <fieldset disabled={skeleton} className="flex min-w-0 items-center gap-2">
            {filter === undefined ? null : <Tool tool={filter} kind="filter" />}
            {sort === undefined ? null : <Tool tool={sort} kind="sort" />}
            {columns === undefined ? null : <Tool tool={columns} kind="columns" />}
          </fieldset>
        ) : null}
        {sortedLine === undefined ? null : (
          <p className="text-sm text-fg-muted sm:ms-auto">{sortedLine}</p>
        )}
      </div>
      {chips === null ? null : <FilterChipRow {...chips} />}
      {failure === null || firstLoadError ? null : (
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
      {firstLoadError && failure !== null ? (
        <LoadError
          // In the list's own column: no page padding of its own.
          className=""
          {...(failure.title === undefined ? {} : { title: failure.title })}
          message={failure.message}
          retryLabel={failure.retry?.label ?? ''}
          onRetry={failure.retry?.onClick ?? (() => {})}
        />
      ) : null}
      {skeleton || (ready && !firstLoadError) ? (
        <ListRefreshing refreshing={status.refreshing} busy={loading}>
          {table}
        </ListRefreshing>
      ) : null}
      {loading && !ready && !firstLoadError ? (
        <ListLoadingStatus label={loadingLabel} slow={status.slow} slowLabel={slowLabel} />
      ) : null}
      {ready && !skeleton && !firstLoadError && pagination !== null ? (
        <ListPagination {...pagination} />
      ) : null}
      {dialogs}
    </div>
  );
}
