'use client';

import {
  Button,
  EmptyState,
  LinkButton,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { ListPagingMode } from '../sales/cursor-paging.ts';
import { stepStack } from '../sales/cursor-paging.ts';
import { SelectionBar } from '../sales/selection-bar.tsx';
import { numberFormat } from '../shared/intl.ts';
import { DEFAULT_COLUMNS, cleanColumns, type OptionalColumn } from './list/posts-columns.ts';
import { PostsColumnsPanel } from './list/posts-columns-panel.tsx';
import { PostsBulk } from './list/posts-export.tsx';
import { PostsFilterPanel } from './list/posts-filter-panel.tsx';
import {
  DEFAULT_QUERY,
  FILTER_FIELDS,
  MAX_PAGED_ROWS,
  PAGE_SIZES,
  SEARCH_MAX,
  SELECTION_MAX,
  VIEWS,
  defaultDirection,
  filterCount,
  type FilterField,
  type Filters,
  type PostListPage,
  type Query,
  type View,
  type ViewCounts,
} from './list/posts-list-types.ts';
import { queryString, searchText } from './list/posts-query.ts';
import { usePostRowActions } from './list/posts-row-actions.tsx';
import { PostsSortPanel } from './list/posts-sort-panel.tsx';
import { PostsTable } from './list/posts-table.tsx';
import { NEW_POST_PATH, TAXONOMY_PATH } from './types.ts';

type Failure = 'denied' | 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  if (status === 403) return 'denied';
  // The API refused the query itself: asking again can never work.
  if (code === 'validation.failed') return 'refused';
  return 'unavailable';
}

const noActions = () => [];

// The query rules of the kit hook, kept at module level so they stay the same between renders.
// Every change but a page move starts again on the first page, with no cursor.
const forView = (view: string): Query => ({ ...DEFAULT_QUERY, view: view as View });
const withView = (current: Query, view: string): Query => ({
  ...current,
  view: view as View,
  cursors: [],
});
const searchOf = (current: Query): string => current.q;
const withSearch = (current: Query, text: string): Query => ({
  ...current,
  q: searchText(text),
  cursors: [],
});

/**
 * The admin Blog posts list (super list 26): the views by status with their counts, one search
 * box (part of a title or web address), the filter, sort and column panels with their chips, then
 * one page of posts with the row Actions menu. It follows the Market's List paging setting: page
 * numbers with a total and any sort, or Previous and next, newest created first. Rows can be
 * selected for the one bulk action, Export. New post (when the role may write) and Categories and
 * tags stay in the heading. Every row action opens a page of its own, so nothing here changes a
 * post. Saved filters wait for their API.
 */
export function PostsList({
  paging,
  accountId,
  marketId,
  zone,
  canEdit,
  initialView = 'all',
}: {
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  /** The signed-in admin (the column choice is kept per admin). */
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the date presets (ADR-0005). */
  readonly zone: string;
  /** The role may write posts: New post is shown. */
  readonly canEdit: boolean;
  /** The view a link opens (`?view=`), All by default. */
  readonly initialView?: View;
}) {
  const t = useTranslations('blog.list');
  const tb = useTranslations('blog');
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const rowActions = usePostRowActions();
  const { query, draft, setDraft, change, goToPage, paginate, openView, reset } =
    useSuperListQuery<Query>({
      defaultQuery: { ...DEFAULT_QUERY, view: initialView },
      forView,
      withView,
      searchOf,
      withSearch,
    });
  // A change of what is listed starts on the first page with no cursor.
  const changeList = (patch: Partial<Query>) => change({ cursors: [], ...patch });

  const [answer, setAnswer] = useState<PostListPage | null>(null);
  // The view counts of the last answer: they stay while a page loads or a read fails.
  const [counts, setCounts] = useState<ViewCounts | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'blog-posts-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the rows and not on the control they used.
  const listTop = useRef<HTMLDivElement>(null);
  // When the rows on show were read: an export of "all matching" reads its date presets on this
  // clock, so the file covers the same window as the screen even across midnight.
  const [readAt, setReadAt] = useState<Date | null>(null);
  const focusList = useRef(false);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  // The date presets are read at each load (and each Try again), on the clock of the list's zone.
  const load = useCallback(
    async (asked: Query) => {
      const now = new Date();
      const request = queryString(asked, { paging, zone, now });
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<PostListPage>('GET', `blog/admin/posts?${request}`);
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        const { status, code, details: problem } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (code === 'validation.failed') {
          // The panel never builds an invalid query: say what the API refused, once, for support.
          console.warn('blog.posts-refused', problem?.fields ?? []);
        }
        setFailure(failureOf(status, code));
        return;
      }
      setFailure(null);
      setAnswer(result.body);
      setCounts(result.body.counts);
      setReadAt(now);
    },
    [paging, zone],
  );

  // A query that is equal in content is not a new list: load again only when it changed.
  const queryNow = useRef(query);
  queryNow.current = query;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    void load(queryNow.current);
  }, [load, queryKey]);

  // A new view, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages. The search goes in as it is sent, in lower
  // case (the API matches any case), so the same words typed with other spaces or letter case
  // keep the ticks.
  const listKey = JSON.stringify([
    query.view,
    searchText(query.q).toLowerCase(),
    query.filters,
    query.sort,
    query.direction,
  ]);
  const rows = answer?.items;
  const pageIds = useMemo(() => rows?.map((row) => row.id) ?? [], [rows]);
  const selection = useRowSelection(pageIds, SELECTION_MAX, listKey);
  // Panel loading L2: skeleton rows on the first load, dimmed rows on a later one.
  const status = useListLoading(loading, answer !== null);
  // A first load that runs past 30 s gives up: its answer is dropped and Try again starts anew.
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure('unavailable');
  }, [status.stalled]);

  useEffect(() => {
    if (loading || !focusList.current) return;
    focusList.current = false;
    listTop.current?.focus();
  }, [loading, answer]);

  // The API answers with a total only for page numbers: its answer, not the setting, says which
  // footer fits the rows on show.
  const mode: ListPagingMode = answer === null || answer.total === null ? 'prev-next' : paging;
  const pageSize = answer?.pageSize ?? query.pageSize;
  const page = mode === 'pages' ? (answer?.page ?? query.page) : query.cursors.length + 1;
  const start = (page - 1) * pageSize;

  // A page past the end (posts left the view meanwhile) goes back one page. Once per answer: the
  // step back changes the query before the next read starts, and must not step again.
  const steppedBack = useRef<PostListPage | null>(null);
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.items.length > 0) return;
    if (steppedBack.current === answer) return;
    steppedBack.current = answer;
    if (mode === 'pages' && (answer.page ?? 1) > 1) {
      const last =
        answer.total === null ? 1 : Math.max(1, Math.ceil(answer.total / answer.pageSize));
      goToPage(Math.min(last, (answer.page ?? 1) - 1));
    } else if (mode === 'prev-next' && query.cursors.length > 0) {
      paginate({ cursors: query.cursors.slice(0, -1) });
    }
  }, [answer, loading, failure, mode, query.cursors, goToPage, paginate]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const searched = searchText(query.q);

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {}, cursors: [] });
  const withoutFilter = (field: FilterField): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const filterValue = (field: FilterField): string | null => {
    const { filters } = query;
    switch (field) {
      case 'kind':
        return filters.kind === undefined ? null : t(`filter.kind.${filters.kind}`);
      case 'owner':
        return filters.owner === undefined ? null : t(`filter.owner.${filters.owner}`);
      case 'featured':
        return filters.featured === undefined ? null : t(`filter.featured.${filters.featured}`);
      case 'updated':
        return filters.updated === undefined ? null : ts(`date-preset.${filters.updated}`);
    }
  };
  const chips = [
    ...(searched === ''
      ? []
      : [
          {
            key: 'search',
            label: t('chip-search', { text: searched }),
            onRemove: () => reset({ q: '', cursors: [] }),
          },
        ]),
    ...FILTER_FIELDS.flatMap((field) => {
      const value = filterValue(field);
      return value === null
        ? []
        : [
            {
              key: field,
              label: ts('chip', { field: t(`filter.name.${field}`), value }),
              onRemove: () => changeList({ filters: withoutFilter(field) }),
            },
          ];
    }),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  // Previous and next lists the newest created first only: the sort is fixed there.
  const sortable = paging === 'pages';
  const shownSort = sortable ? query.sort : DEFAULT_QUERY.sort;
  const shownDirection = sortable ? query.direction : DEFAULT_QUERY.direction;
  const sortField = t(`sort.field.${shownSort}`);
  const sortOrder = t(
    `sort.${shownSort}.${shownDirection === defaultDirection(shownSort) ? 'first' : 'second'}`,
  );
  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'file'}
      title={
        filtered
          ? t('empty.no-match')
          : t(query.view === 'all' && canEdit ? 'empty.all-create' : `empty.${query.view}`)
      }
      body={filtered ? t('empty.no-match-help') : undefined}
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {ts('clear-all')}
          </Button>
        ) : undefined
      }
    />
  );

  if (failure === 'denied') {
    return <p className="text-fg-muted">{t('no-access')}</p>;
  }

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';
  const shown = answer?.items ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.id));
  const moreThanPage =
    mode === 'pages'
      ? (answer?.total ?? 0) > shown.length
      : answer?.nextCursor !== null || query.cursors.length > 0;

  const table = (
    <div className="flex flex-col gap-4">
      <SelectionBar
        active={selection.selected.size > 0 || selection.allMatching}
        allMatching={selection.allMatching}
        canSelectAll={wholePageTicked && moreThanPage && failure === null}
        labels={{
          selected: t('selection.selected', { count: selection.selected.size }),
          all: total === null ? t('selection.all-open') : t('selection.all', { count: total }),
          selectAll:
            total === null
              ? t('selection.select-all-open')
              : t('selection.select-all', { count: total }),
          clear: t('selection.clear'),
        }}
        onSelectAll={selection.selectAllMatching}
        onClear={selection.clear}
      />
      <div ref={listTop} tabIndex={-1} className="outline-none">
        <PostsTable
          rows={shown}
          columns={columns}
          zone={zone}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
          // Rows kept after a failed refresh belong to another list than the query: no actions.
          actions={failure === null ? rowActions : noActions}
          selection={selection}
        />
      </div>
    </div>
  );

  return (
    <SuperList
      heading={{
        actions: (
          <>
            <LinkButton variant="secondary" href={TAXONOMY_PATH}>
              {tb('taxonomy-link')}
            </LinkButton>
            {canEdit ? <LinkButton href={NEW_POST_PATH}>{tb('new')}</LinkButton> : null}
            <PostsBulk
              selection={{
                ids: [...selection.selected],
                allMatching: selection.allMatching,
                total,
              }}
              query={query}
              paging={paging}
              zone={zone}
              columns={columns}
              now={readAt ?? undefined}
            />
          </>
        ),
      }}
      views={{
        label: t('views-label'),
        activeId: query.view,
        onSelect: (id) => openView(id),
        items: VIEWS.map((view) => ({
          id: view,
          label: `${t(`view.${view}`)}${counts === null ? '' : ` (${number(counts[view])})`}`,
        })),
        // Saved filters for this list arrive with their API.
        manage: null,
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        value: draft,
        maxLength: SEARCH_MAX,
        help: t('search.help'),
        onChange: setDraft,
        onSubmit: (value) => changeList({ q: searchText(value) }),
      }}
      filter={{
        label: ts('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <PostsFilterPanel
            filters={query.filters}
            onApply={(filters) => changeList({ filters })}
            close={close}
          />
        ),
      }}
      {...(sortable
        ? {
            sort: {
              label: ts('sort.button'),
              panel: () => (
                <PostsSortPanel
                  sort={query.sort}
                  direction={query.direction}
                  onChange={(sort, direction) => changeList({ sort, direction })}
                />
              ),
            },
          }
        : {})}
      columns={{
        label: ts('columns.button'),
        panel: (close) => (
          <PostsColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      sortedLine={t('sorted', { field: sortField, order: sortOrder })}
      chips={
        filtered
          ? {
              chips,
              clearAll: { label: ts('clear-all'), onClick: clearAll },
              status: total === null || failure !== null ? '' : t('match', { count: total }),
            }
          : null
      }
      failure={
        failure === null
          ? null
          : failure === 'refused'
            ? // Asking again cannot work: no Try again, the words say what to change.
              { message: t('error.refused') }
            : {
                message: t('error.unavailable'),
                retry: { label: tl('retry'), onClick: () => void load(query) },
              }
      }
      firstLoadError={firstLoadError}
      loading={loading}
      status={status}
      loadingLabel={t('loading')}
      slowLabel={tl('slow')}
      ready={answer !== null}
      table={table}
      pagination={
        answer !== null && answer.items.length > 0 && failure === null
          ? {
              mode,
              page,
              pageSize,
              pageSizes: PAGE_SIZES,
              // Page numbers stop at row 10,000; Previous and next tells the footer one row past
              // this page while another follows, so Next knows where the end is.
              total:
                mode === 'pages'
                  ? Math.min(answer.total ?? 0, MAX_PAGED_ROWS)
                  : answer.nextCursor !== null
                    ? page * pageSize + 1
                    : start + answer.items.length,
              maxRows: mode === 'pages' ? MAX_PAGED_ROWS : Number.MAX_SAFE_INTEGER,
              // Previous and next has no total, so no range line.
              range:
                mode === 'pages' && answer.total !== null
                  ? t('range', {
                      from: number(start + 1),
                      to: number(start + answer.items.length),
                      total: number(answer.total),
                    })
                  : '',
              labels: {
                rowsPerPage: ts('paging.rows-per-page'),
                previous: ts('paging.previous'),
                next: ts('paging.next'),
                pages: ts('paging.pages'),
                page: (n) => ts('paging.page', { page: n }),
                narrowTitle: ts('paging.narrow'),
                narrowBody: ts('paging.narrow-help'),
              },
              disabled: loading,
              onPage: (target) => {
                focusList.current = true;
                if (mode === 'pages') goToPage(target);
                else paginate({ cursors: stepStack(query.cursors, target, answer.nextCursor) });
              },
              onPageSize: (size) => paginate({ pageSize: size, cursors: [] }),
            }
          : null
      }
    />
  );
}
