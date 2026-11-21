'use client';

import {
  Button,
  EmptyState,
  Icon,
  LinkButton,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useRowSelection,
  useBaseTabCounts,
  useSuperListQuery,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { ProductsBulk } from './products-bulk.tsx';
import { ProductsColumnsPanel } from './products-columns-panel.tsx';
import { ProductsFilterPanel } from './products-filter-panel.tsx';
import { ManageFiltersDialog } from './products-saved-manage.tsx';
import { SaveFilterDialog } from './products-saved-save.tsx';
import {
  LIST_KEY,
  SHARE_PERMISSION,
  queryOf,
  type SavedFiltersAnswer,
} from './products-saved-types.ts';
import { useProductRowActions } from './products-row-actions.tsx';
import { ProductsSortPanel } from './products-sort-panel.tsx';
import { ProductsTable } from './products-table.tsx';
import {
  BULK_MAX_IDS,
  DEFAULT_COLUMNS,
  DEFAULT_QUERY,
  FILTER_FIELDS,
  MAX_LIST_ROWS,
  PAGE_SIZES,
  SEARCH_MAX,
  VIEWS,
  cleanColumns,
  filterCount,
  orderKey,
  queryString,
  type CategoryTree,
  type Filters,
  type ListPagingMode,
  type OptionalColumn,
  type ProductsPage,
  type ViewCounts,
  type Query,
  type View,
} from './products-types.ts';

const noActions = () => [];

type Failure = 'denied' | 'too-broad' | 'unavailable';

function failureOf(
  status: number,
  code: string,
  details: readonly { path: string; code: string }[],
) {
  if (code === 'validation.failed' && details.some((field) => field.code === 'too-broad')) {
    return 'too-broad' as const;
  }
  return status === 401 || status === 403 ? ('denied' as const) : ('unavailable' as const);
}

/**
 * The admin product list (catalog design 9.2b): the Active, All and Inactive tabs with their
 * counts, a search box, the filter builder, the sort menu and the column picker, then one page of
 * products. The column choice is the viewer's own and lives in this browser's storage (the list
 * works the same when storage is missing). Rows can be selected, and the Bulk action button in the
 * header (Activate, Deactivate, Export, Delete) acts on the selection (catalog design 9.2c).
 */
export function ProductsList({
  accountId,
  marketId,
  marketName,
  timeZone,
  permissionKeys,
  csrfToken,
  paging,
}: {
  readonly accountId: string;
  readonly marketId: string;
  /** The Market's display name for the subtitle (configuration, never a code). */
  readonly marketName: string;
  readonly timeZone: string;
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
}) {
  const t = useTranslations('catalog.products');
  const tl = useTranslations('load');
  const locale = useLocale();
  const {
    query,
    draft,
    setDraft,
    savedId,
    change,
    goToPage,
    paginate,
    openView,
    openSaved: openSavedTab,
    forgetSaved,
    reset,
  } = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView: (view) => ({ ...DEFAULT_QUERY, view: view as View }),
    withView: (current, view) => ({ ...current, view: view as View }),
    searchOf: (current) => current.q,
    withSearch: (current, q) => ({ ...current, q }),
  });
  const [answer, setAnswer] = useState<ProductsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [categories, setCategories] = useState<CategoryTree['categories']>([]);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  // The saved views (catalog design 9.2d): null until they load, and when they cannot (the page
  // then has the three fixed tabs only).
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'products-columns');

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  // The category names for the filter panel; without them the panel simply has no category field.
  useEffect(() => {
    let live = true;
    void callApi<CategoryTree>('GET', 'catalog/categories').then((result) => {
      if (live && result.ok) setCategories(result.body.categories);
    });
    return () => {
      live = false;
    };
  }, []);

  const loadSaved = useCallback(async () => {
    const result = await callApi<SavedFiltersAnswer>(
      'GET',
      `catalog/admin/saved-filters?listKey=${LIST_KEY}`,
    );
    if (!result.ok) return;
    setSaved(result.body);
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  // A saved view that was deleted (here or by its owner) is no longer the one on show.
  useEffect(() => {
    if (savedId !== null && saved !== null && !saved.items.some((item) => item.id === savedId)) {
      forgetSaved();
    }
  }, [saved, savedId, forgetSaved]);

  const load = useCallback(async (next: Query) => {
    const ticket = ++latest.current;
    setLoading(true);
    setFailure(null);
    const result = await callApi<ProductsPage>(
      'GET',
      `catalog/admin/products?${queryString(next)}`,
    );
    if (ticket !== latest.current) return;
    setLoading(false);
    if (!result.ok) {
      setFailure(
        failureOf(result.failure.status, result.failure.code, result.failure.details?.fields ?? []),
      );
      return;
    }
    setAnswer(result.body);
  }, []);

  useEffect(() => {
    void load(query);
  }, [load, query]);

  // A new tab, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages.
  const listKey = JSON.stringify([query.view, query.q, query.filters, query.sort, query.direction]);
  const pageIds = useMemo(() => answer?.items.map((item) => item.productId) ?? [], [answer]);
  const selection = useRowSelection(pageIds, BULK_MAX_IDS, listKey);
  // Panel loading L2: skeleton rows on the first load, dimmed rows on a later one.
  const status = useListLoading(loading, answer !== null);
  // A first load that runs past 30 s gives up: its answer is dropped and Try again starts anew.
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure('unavailable');
  }, [status.stalled]);
  // The first load failed: the load error in place of the list.
  const firstLoadError = answer === null && failure === 'unavailable';
  const skeleton = status.skeleton && failure === null;
  const { selected, allMatching } = selection;
  const clearSelection = selection.clear;

  // The Market's List paging decides what the answer holds: page numbers need the total, Previous
  // and next only whether another page follows. Without a total the footer is told one row
  // past this page while another page follows, so its Next button knows where the end is.
  const total =
    answer === null
      ? 0
      : (answer.total ??
        (answer.hasNext
          ? answer.page * answer.pageSize + 1
          : (answer.page - 1) * answer.pageSize + answer.items.length));
  const mode: ListPagingMode =
    answer?.total === null || answer?.total === undefined ? 'prev-next' : paging;

  // A page past the end (rows were deleted meanwhile) goes to the last one.
  useEffect(() => {
    if (answer === null || loading || failure !== null) return;
    if (answer.items.length === 0 && answer.page > 1) {
      const last =
        answer.total === null ? 1 : Math.max(1, Math.ceil(answer.total / answer.pageSize));
      goToPage(Math.min(last, answer.page - 1));
    }
  }, [answer, loading, failure, goToPage]);

  const openSaved = (id: string) => {
    const filter = saved?.items.find((item) => item.id === id);
    if (filter === undefined) return;
    openSavedTab(id, { ...queryOf(filter.payload), pageSize: query.pageSize });
  };
  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {} });
  const withoutFilter = (field: (typeof FILTER_FIELDS)[number]): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const canShare = saved?.canShare ?? permissionKeys.includes(SHARE_PERMISSION);
  const limits = saved?.limits ?? { perOwner: 50, shared: 20 };

  const number = (value: number) => numberFormat(locale, {}).format(value);
  // A saved filter is a tab of its own: it does not narrow the counts of the built-in tabs.
  const counts = useBaseTabCounts<ViewCounts>({
    savedId,
    live: answer?.counts ?? null,
    load: async () => {
      const result = await callApi<ProductsPage>(
        'GET',
        `catalog/admin/products?${queryString({ ...DEFAULT_QUERY, pageSize: 1 })}`,
      );
      return result.ok ? result.body.counts : null;
    },
  });
  const filtered = query.q !== '' || filterCount(query.filters) > 0;
  const chipLabel = (field: (typeof FILTER_FIELDS)[number]): string | null => {
    const value = query.filters[field];
    if (value === undefined) return null;
    const shown =
      field === 'categoryId'
        ? (categories.find((category) => category.id === value)?.name ?? value)
        : t(`${field === 'status' ? 'status' : 'scope'}.${value}`);
    return t('chip', { field: t(`filter.name.${field}`), value: shown });
  };
  const chips = FILTER_FIELDS.flatMap((field) => {
    const label = chipLabel(field);
    return label === null ? [] : [{ field, label }];
  });

  const summary = [
    t(`tab.${query.view}`),
    ...(query.q === '' ? [] : [t('saved.summary-search', { q: query.q })]),
    ...chips.map((chip) => chip.label),
  ].join(' · ');

  const start = answer === null ? 0 : (answer.page - 1) * answer.pageSize;
  const sortName = t(`sort.field.${query.sort}`);
  const sortOrder = t(`sort.${orderKey(query.sort, query.direction)}`);

  const rowActions = useProductRowActions({
    csrfToken,
    onChanged: () => {
      void load(query);
      void loadSaved();
    },
  });

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'package'}
      title={
        filtered
          ? t('empty.no-match')
          : (counts !== null && counts.all > 0) || (counts === null && query.view !== 'all')
            ? t(`empty.view.${query.view}`)
            : t('empty.none')
      }
      body={
        filtered
          ? t('empty.no-match-help')
          : (counts !== null && counts.all > 0) || (counts === null && query.view !== 'all')
            ? undefined
            : t('empty.none-help')
      }
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {t('clear-all')}
          </Button>
        ) : undefined
      }
    />
  );

  const failureText = failure === null ? '' : t(`error.${failure}`);

  return (
    <SuperList
      heading={{
        subtitle: counts === null ? '' : t('subtitle', { count: counts.all, market: marketName }),
        actions: (
          <>
            <ProductsBulk
              // Rows kept after a failed refresh belong to another list than the query: no
              // "select all matching" over them.
              selection={{
                ids: [...selected],
                allMatching,
                total: failure === null ? (answer?.total ?? 0) : 0,
              }}
              query={query}
              columns={columns}
              permissionKeys={permissionKeys}
              csrfToken={csrfToken}
              onSelectAll={selection.selectAllMatching}
              onClear={clearSelection}
              onChanged={() => {
                clearSelection();
                void load(query);
                void loadSaved();
              }}
            />
            {permissionKeys.includes('catalog.platform-product.edit') ? (
              <LinkButton href="/catalog/products/new">{t('add')}</LinkButton>
            ) : null}
            {permissionKeys.includes('catalog.platform-import.run') ? (
              <LinkButton variant="secondary" href="/catalog/products/import" className="gap-2">
                <Icon name="file" />
                {t('import')}
              </LinkButton>
            ) : null}
          </>
        ),
      }}
      views={{
        label: t('tabs'),
        activeId: savedId ?? query.view,
        onSelect: (id) => {
          if (saved?.items.some((item) => item.id === id)) openSaved(id);
          else openView(id);
        },
        items: [
          ...VIEWS.map((view) => ({
            id: view,
            label: `${t(`tab.${view}`)}${counts === null ? '' : ` (${number(counts[view])})`}`,
          })),
          ...(saved?.items ?? []).map((item) => {
            const count = item.id === savedId ? (answer?.total ?? item.count) : item.count;
            return {
              id: item.id,
              label: `${item.name}${count === null ? '' : ` (${number(count)})`}`,
            };
          }),
        ],
        manage:
          saved === null
            ? null
            : { label: t('saved.manage-link'), onClick: () => setDialog('manage') },
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        value: draft,
        maxLength: SEARCH_MAX,
        onChange: setDraft,
        onSubmit: (value) => change({ q: value }),
      }}
      filter={{
        label: t('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <ProductsFilterPanel
            filters={query.filters}
            categories={categories}
            onApply={(filters) => change({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: t('sort.button'),
        panel: () => (
          <ProductsSortPanel
            sort={query.sort}
            direction={query.direction}
            onChange={(sort, direction) => change({ sort, direction })}
          />
        ),
      }}
      columns={{
        label: t('columns.button'),
        panel: (close) => (
          <ProductsColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      sortedLine={t('sorted', { field: sortName, order: sortOrder })}
      chips={
        filtered
          ? {
              chips: chips.map((chip) => ({
                key: chip.field,
                label: chip.label,
                removeLabel: t('chip-remove', { filter: chip.label }),
                onRemove: () => change({ filters: withoutFilter(chip.field) }),
              })),
              clearAll: { label: t('clear-all'), onClick: clearAll },
              ...(saved === null || savedId !== null
                ? {}
                : { save: { label: t('saved.save-link'), onClick: () => setDialog('save') } }),
              status:
                answer === null || failure !== null || answer.total === null
                  ? ''
                  : t('match', { count: answer.total }),
            }
          : null
      }
      failure={
        failure === null
          ? null
          : {
              message: failureText,
              ...(failure === 'unavailable'
                ? { retry: { label: tl('retry'), onClick: () => void load(query) } }
                : {}),
            }
      }
      firstLoadError={firstLoadError}
      loading={loading}
      status={status}
      loadingLabel={t('loading')}
      slowLabel={tl('slow')}
      ready={answer !== null}
      table={
        <ProductsTable
          rows={answer?.items ?? []}
          columns={columns}
          timeZone={timeZone}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
          // Rows kept after a failed refresh belong to another list than the query: no actions on them.
          actions={failure === null ? rowActions.items : noActions}
          selection={selection}
        />
      }
      pagination={
        answer !== null && answer.items.length > 0
          ? {
              mode,
              page: answer.page,
              pageSize: answer.pageSize,
              pageSizes: PAGE_SIZES,
              total,
              maxRows: MAX_LIST_ROWS,
              range:
                answer.total === null
                  ? t('range-open', {
                      from: number(start + 1),
                      to: number(start + answer.items.length),
                    })
                  : t('range', {
                      from: number(start + 1),
                      to: number(start + answer.items.length),
                      total: number(answer.total),
                    }),
              labels: {
                rowsPerPage: t('paging.rows-per-page'),
                previous: t('paging.previous'),
                next: t('paging.next'),
                pages: t('paging.pages'),
                page: (page) => t('paging.page', { page }),
                narrowTitle: t('paging.narrow'),
                narrowBody: t('paging.narrow-help'),
              },
              disabled: loading,
              onPage: goToPage,
              onPageSize: (pageSize) => paginate({ pageSize }),
            }
          : null
      }
      dialogs={
        <>
          {rowActions.dialogs}
          <SaveFilterDialog
            open={dialog === 'save'}
            onClose={() => setDialog(null)}
            query={query}
            summary={summary}
            canShare={canShare}
            limits={limits}
            csrfToken={csrfToken}
            onSaved={(filter) => {
              void loadSaved().then(() => openSavedTab(filter.id, query));
            }}
          />
          <ManageFiltersDialog
            open={dialog === 'manage'}
            onClose={() => setDialog(null)}
            filters={saved?.items ?? []}
            canShare={canShare}
            limits={limits}
            csrfToken={csrfToken}
            onChanged={() => void loadSaved()}
          />
        </>
      }
    />
  );
}
