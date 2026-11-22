'use client';

import {
  Banner,
  Button,
  EmptyState,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
  useBaseTabCounts,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { numberFormat } from '../../shared/intl.ts';
import type { ListPagingMode } from '../../sales/cursor-paging.ts';
import { SelectionBar } from '../../sales/selection-bar.tsx';
import { SalesSavedViews } from '../../sales/sales-saved-views.tsx';
import { useSavedFilters } from '../../sales/sales-saved.ts';
import { shortInstantInZone } from '../../shared/format.ts';
import { usePoll } from '../parts.tsx';
import { PAGE_POLL_MS, type Severity } from '../types.ts';
import { DEFAULT_COLUMNS, cleanColumns, type OptionalColumn } from './list-columns.ts';
import { AlertBulk } from './list-export.tsx';
import { AlertColumnsPanel, AlertFilterPanel, AlertSortPanel } from './list-panels.tsx';
import { queryString, searchText } from './list-query.ts';
import { alertRowActions } from './list-row-actions.ts';
import { LIST_KEY, payloadOf, queryOf, type SavedPayload } from './list-saved.ts';
import { AlertTable } from './list-table.tsx';
import {
  DEFAULT_QUERY,
  FILTER_FIELDS,
  PAGE_SIZE,
  SEARCH_MAX,
  SELECTION_MAX,
  VIEWS,
  defaultDirection,
  filterCount,
  type Filters,
  type AlertCounts,
  type AlertListPage,
  type AlertListRow,
  type Query,
  type View,
} from './list-types.ts';

type Failure = 'denied' | 'refused' | 'unavailable';

function failureOf(status: number, code: string): Failure {
  if (status === 403) return 'denied';
  // The API refused the query itself: asking again can never work.
  if (code === 'validation.failed') return 'refused';
  return 'unavailable';
}

const noActions = () => [];

// The query rules of the kit hook, kept at module level so they stay the same between renders.
const forView = (view: string): Query => ({ ...DEFAULT_QUERY, view: view as View });
const withView = (current: Query, view: string): Query => ({ ...current, view: view as View });
const searchOf = (current: Query): string => current.q;
const withSearch = (current: Query, text: string): Query => ({ ...current, q: searchText(text) });

/** The `?severity=` of a link is only a start: removing its chip should not come back on reload. */
function forgetUrlFilters() {
  try {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('severity')) return;
    url.searchParams.delete('severity');
    window.history.replaceState(window.history.state, '', url);
  } catch {
    // The address bar is a convenience; the list works without it.
  }
}

/**
 * The security centre's alerts as a super list (list 37): views by state with their counts, one
 * search box (the key of an alert, exact: an account id, an address, the Market code or an event
 * id), the filter, sort and column panels with their chips, then one page of alerts with the row
 * Actions menu. It follows the Market's List paging setting: page numbers with a total, or
 * Previous and Next. Rows can be selected for the one bulk action, Export (there is no bulk
 * acknowledge or resolve). Saved filters (the generic lists routes) add tabs after the views; when
 * the route fails or does not know the list yet, they are hidden. The list reads again every 30 s
 * while the tab is visible and keeps its page, filters and focus; when a read fails it keeps the
 * last rows and says so. An alert is acknowledged and resolved on its own page.
 */
export function AlertList({
  paging,
  accountId,
  marketId,
  zone,
  now,
  noRoster,
  initialView = DEFAULT_QUERY.view,
  initialSeverity,
  csrfToken = '',
}: {
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the date presets (ADR-0005). */
  readonly zone: string;
  /** The page's clock, for "5 min ago" and the S1 timer. */
  readonly now: number;
  /** No on-call roster: S1 and S2 alerts are not being sent. */
  readonly noRoster: boolean;
  /** The view a link opens (`?view=`); open alerts by default. */
  readonly initialView?: View;
  /** One severity a link starts on (`?severity=`), shown as a chip that can be removed. */
  readonly initialSeverity?: Severity;
  readonly csrfToken?: string;
}) {
  const t = useTranslations('security-centre.list');
  const ts = useTranslations('sales-lists');
  const tl = useTranslations('load');
  const locale = useLocale();
  const {
    query,
    draft,
    setDraft,
    savedId,
    change,
    goToPage,
    openView,
    openSaved: openSavedTab,
    forgetSaved,
    reset,
  } = useSuperListQuery<Query>({
    defaultQuery: {
      ...DEFAULT_QUERY,
      view: initialView,
      filters: initialSeverity === undefined ? {} : { severity: initialSeverity },
    },
    forView,
    withView,
    searchOf,
    withSearch,
  });

  const [answer, setAnswer] = useState<AlertListPage | null>(null);
  // The view counts of the last answer: they stay while a page loads or a read fails.
  const [counts, setCounts] = useState<AlertCounts | null>(null);
  // A saved filter is a tab of its own: it does not narrow the counts of the built-in tabs.
  const tabCounts = useBaseTabCounts<AlertCounts>({
    savedId,
    live: counts,
    load: async () => {
      const request = queryString(DEFAULT_QUERY, { paging, zone, now: new Date() });
      const result = await callApi<AlertListPage>('GET', `security/admin/alerts/list?${request}`);
      return result.ok ? result.body.counts : null;
    },
  });
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const router = useRouter();
  // When the rows on show were read; a later read that fails keeps them and says so.
  const [readAt, setReadAt] = useState<string | null>(null);
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'security-alert-columns');
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  const { saved, reload: loadSaved } = useSavedFilters<SavedPayload>(LIST_KEY);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  // A saved tab that was deleted (here or by its owner) is no longer the one on show.
  useEffect(() => {
    if (savedId !== null && saved !== null && !saved.items.some((item) => item.id === savedId)) {
      forgetSaved();
    }
  }, [saved, savedId, forgetSaved]);

  // The date presets are read at each load (and each Try again), on the clock of the list's zone.
  const load = useCallback(
    async (asked: Query, quiet = false) => {
      const request = queryString(asked, { paging, zone, now: new Date() });
      const ticket = ++latest.current;
      // `quiet`: the 30-second read, which never dims the rows or drops them when it fails.
      if (!quiet) {
        setLoading(true);
        setFailure(null);
      }
      const result = await callApi<AlertListPage>('GET', `security/admin/alerts/list?${request}`);
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        focusList.current = false;
        const { status, code, details } = result.failure;
        if (status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (quiet) {
          setRefreshFailed(true);
          return;
        }
        if (code === 'validation.failed') {
          // The panel never builds an invalid query: say what the API refused, once, for support.
          console.warn('security.alert-list-refused', details?.fields ?? []);
        }
        setFailure(failureOf(status, code));
        return;
      }
      setRefreshFailed(false);
      setFailure(null);
      setReadAt(new Date().toISOString());
      setAnswer(result.body);
      setCounts(result.body.counts);
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

  // F4: the list reads again every 30 s while the tab is visible. A read still running (or not
  // yet answered) is not asked again, and the read never moves focus or resets the page.
  usePoll(() => {
    if (!loading && answer !== null) void load(queryNow.current, true);
  }, PAGE_POLL_MS);

  // A new view, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages.
  const listKey = JSON.stringify([query.view, query.q, query.filters, query.sort, query.direction]);
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
    if (!loading && focusList.current) {
      focusList.current = false;
      listTop.current?.focus();
    }
  }, [loading, answer]);

  // The API answers with a total only for page numbers: its answer, not the setting, says which
  // footer fits the rows on show.
  const mode: ListPagingMode = answer === null || answer.total === null ? 'prev-next' : paging;

  // A page past the end (rows were moderated meanwhile) goes back to the last one that has rows.
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.items.length > 0) return;
    if (answer.page > 1) {
      // Without a total the page before is the nearest one that can still have rows.
      const last =
        answer.total === null
          ? answer.page - 1
          : Math.max(1, Math.ceil(answer.total / answer.pageSize));
      goToPage(Math.max(1, Math.min(last, answer.page - 1)));
    }
  }, [answer, loading, failure, goToPage]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const tc = useTranslations('security-centre');

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => {
    reset({ q: '', filters: {} });
    forgetUrlFilters();
  };
  const withoutFilter = (field: (typeof FILTER_FIELDS)[number]): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const filterValue = (field: (typeof FILTER_FIELDS)[number]): string | null => {
    const value = query.filters[field];
    if (value === undefined) return null;
    switch (field) {
      case 'severity':
        return tc(`severity.${query.filters.severity!}`);
      case 'rule':
        return t(`rule.${query.filters.rule!}`);
      case 'keyType':
        return tc(`key.${query.filters.keyType!}`);
      case 'opened':
        return ts(`date-preset.${value}`);
      case 'minEvents':
        return t('filter.events', { count: Number(value) });
    }
  };
  const chips = [
    ...(query.q !== ''
      ? [
          {
            key: 'search',
            label: t('chip-search', { text: query.q }),
            onRemove: () => reset({ q: '' }),
          },
        ]
      : []),
    ...FILTER_FIELDS.flatMap((field) => {
      const value = filterValue(field);
      return value === null
        ? []
        : [
            {
              key: field,
              label: ts('chip', { field: t(`filter.name.${field}`), value }),
              onRemove: () => {
                change({ filters: withoutFilter(field) });
                if (field === 'severity') forgetUrlFilters();
              },
            },
          ];
    }),
  ].map((chip) => ({ ...chip, removeLabel: ts('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;
  // "Save filter" is offered on a built-in tab that shows something a saved filter can keep.
  const canSave = saved !== null && savedId === null && filtered;
  const sortField = t(`sort.field.${query.sort}`);
  const sortOrder = t(
    `sort.${query.sort}.${query.direction === defaultDirection(query.sort) ? 'first' : 'second'}`,
  );
  const summary = [
    t(`view.${query.view}`),
    ...chips
      .filter((chip) => (FILTER_FIELDS as readonly string[]).includes(chip.key))
      .map((chip) => chip.label),
    ...(query.sort !== DEFAULT_QUERY.sort || query.direction !== DEFAULT_QUERY.direction
      ? [ts('saved.summary-sort', { field: `${sortField}, ${sortOrder}` })]
      : []),
  ].join(' · ');

  const total = failure === null && mode === 'pages' ? (answer?.total ?? null) : null;
  const go = useCallback(
    (id: string) => router.push(`/security/alerts/${encodeURIComponent(id)}`),
    [router],
  );
  const actionLabel = (action: string) => t(`actions.${action}`);
  const rowActions = (row: AlertListRow) => alertRowActions(row, actionLabel, go);

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'shield-check'}
      title={filtered ? t('empty.no-match') : t(`empty.${query.view}`)}
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
    return (
      <div>
        <p className="text-fg-muted">{t('no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('back-home')}
          </a>
        </p>
      </div>
    );
  }

  const skeleton = status.skeleton && failure === null;
  const firstLoadError = answer === null && failure === 'unavailable';
  const shown = answer?.items ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.id));
  const moreThanPage =
    mode === 'pages' ? (answer?.total ?? 0) > shown.length : answer?.hasNext === true;
  const start = answer === null ? 0 : (answer.page - 1) * answer.pageSize;

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
      <div
        ref={listTop}
        tabIndex={-1}
        role="region"
        aria-label={t('title')}
        className="outline-none"
      >
        <AlertTable
          rows={shown}
          columns={columns}
          zone={zone}
          now={now}
          noRoster={noRoster}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(PAGE_SIZE) : undefined}
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
        subtitle: t('intro'),
        actions: (
          <AlertBulk
            selection={{ ids: [...selection.selected], allMatching: selection.allMatching, total }}
            query={query}
            paging={paging}
            zone={zone}
            columns={columns}
          />
        ),
      }}
      notice={
        refreshFailed && readAt !== null && failure === null ? (
          <Banner tone="attention">
            {t('refresh-failed', { time: shortInstantInZone(readAt, locale, zone) })}{' '}
            {t('retrying')}
          </Banner>
        ) : undefined
      }
      views={{
        label: t('views'),
        activeId: savedId ?? query.view,
        onSelect: (id) => {
          const filter = saved?.items.find((item) => item.id === id);
          if (filter === undefined) openView(id);
          else openSavedTab(id, queryOf(filter.payload));
        },
        items: [
          ...VIEWS.map((view) => ({
            id: view,
            label: `${t(`view.${view}`)}${tabCounts === null ? '' : ` (${number(tabCounts[view])})`}`,
          })),
          ...(saved?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
        ],
        manage:
          saved === null
            ? null
            : { label: ts('saved.manage-link'), onClick: () => setDialog('manage') },
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        help: t('search.help'),
        value: draft,
        maxLength: SEARCH_MAX,
        onChange: setDraft,
        onSubmit: (value) => change({ q: searchText(value) }),
      }}
      filter={{
        label: ts('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <AlertFilterPanel
            filters={query.filters}
            onApply={(filters) => change({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: ts('sort.button'),
        panel: () => (
          <AlertSortPanel
            sort={query.sort}
            direction={query.direction}
            onChange={(sort, direction) => change({ sort, direction })}
          />
        ),
      }}
      columns={{
        label: ts('columns.button'),
        panel: (close) => (
          <AlertColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      sortedLine={t('sorted', { field: sortField, order: sortOrder })}
      chips={
        filtered || canSave
          ? {
              chips,
              ...(filtered ? { clearAll: { label: ts('clear-all'), onClick: clearAll } } : {}),
              ...(canSave
                ? { save: { label: ts('saved.save-link'), onClick: () => setDialog('save') } }
                : {}),
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
      dialogs={
        <>
          {saved === null ? null : (
            <SalesSavedViews
              dialog={dialog}
              onClose={() => setDialog(null)}
              listKey={LIST_KEY}
              payload={payloadOf(query)}
              summary={summary}
              saved={saved}
              csrfToken={csrfToken}
              idPrefix="security-alert"
              onSaved={(filter) => {
                void loadSaved().then((items) => {
                  // Only a filter that is in the reloaded list can be the tab on show.
                  if (items?.some((item) => item.id === filter.id) === true)
                    openSavedTab(filter.id, queryOf(filter.payload));
                });
              }}
              onChanged={() => void loadSaved()}
            />
          )}
        </>
      }
      table={table}
      pagination={
        answer !== null && answer.items.length > 0 && failure === null
          ? {
              mode,
              page: answer.page,
              pageSize: answer.pageSize,
              // No page size picker: one size.
              pageSizes: [PAGE_SIZE],
              // Previous and next has no total: the footer is told one row past this page while
              // another follows, so its Next button knows where the end is.
              total:
                answer.total ??
                (answer.hasNext ? answer.page * answer.pageSize + 1 : start + answer.items.length),
              maxRows: Number.MAX_SAFE_INTEGER,
              // Previous and next has no total, so no range line.
              range:
                answer.total === null
                  ? ''
                  : t('range', {
                      from: number(start + 1),
                      to: number(start + answer.items.length),
                      total: number(answer.total),
                    }),
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
                goToPage(target);
              },
              onPageSize: () => {},
            }
          : null
      }
    />
  );
}
