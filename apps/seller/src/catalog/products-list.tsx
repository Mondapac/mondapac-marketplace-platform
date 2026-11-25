'use client';

import {
  Banner,
  BottomSheet,
  Button,
  EmptyState,
  Icon,
  IconButton,
  LinkButton,
  listSkeletonRowCount,
  useListLoading,
  Popover,
  SuperList,
  type MenuItem,
  browserStorage,
  prefsKey,
  readIds,
  useDesktop,
  useRowSelection,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { AddOfferButton } from './add-offer-button.tsx';
import { canRunImport } from './import/import-types.ts';
import { OnThePlatform } from './on-the-platform.tsx';
import {
  ProductsColumnsPanel,
  ProductsFilterPanel,
  ProductsSortPanel,
} from './products-panels.tsx';
import { ProductsExport } from './products-export.tsx';
import { ManageFiltersDialog, SaveFilterDialog } from './products-saved.tsx';
import {
  DEFAULT_LIMITS,
  LIST_KEY,
  SHARE_PERMISSION,
  isPlainView,
  queryOf,
  sameList,
  type SavedFiltersAnswer,
} from './products-saved-types.ts';
import { ProductsTable } from './products-table.tsx';
import { EDIT_PERMISSION } from './types.ts';
import {
  FILTER_FIELDS,
  MAX_LIST_ROWS,
  PAGE_SIZES,
  SELECTION_MAX,
  SEARCH_MAX,
  VIEWS,
  addressOf,
  cleanColumns,
  countOf,
  filterCount,
  isFiltered,
  lastPage,
  orderKey,
  parseQuery,
  queryString,
  DEFAULT_QUERY,
  type CategoryTree,
  type Filters,
  type ListPagingMode,
  type OptionalColumn,
  type ProductRow,
  type ProductsPage,
  type Query,
  type View,
} from './products-list-types.ts';

const noActions = () => [];

type Failure = 'denied' | 'too-broad' | 'unavailable';

const SEARCH_DELAY_MS = 300;

function failureOf(
  status: number,
  code: string,
  details: readonly { path: string; code: string }[],
): Failure | 'range' {
  if (code === 'validation.failed') {
    if (details.some((field) => field.path === 'page')) return 'range';
    if (details.some((field) => field.code === 'too-broad')) return 'too-broad';
  }
  return status === 403 ? 'denied' : 'unavailable';
}

/**
 * The seller's product list on the shared list framework (catalog design 9.2a): the view tabs with
 * their counts, a search box, the filter builder, the sort menu and the column picker, then one page
 * of products with page numbers. The address keeps the view, search, filters, sort and page, so a
 * link opens the same list. The column choice is the viewer's own and lives in this browser's
 * storage (the list works the same when storage is missing). Below 1024 px rows are cards, and
 * the filter and the sort open in a sheet from the bottom.
 */
export function ProductsList({
  accountId,
  marketId,
  timeZone,
  permissionKeys,
  csrfToken,
  categories,
  productTypes,
  paging,
}: {
  readonly accountId: string;
  readonly marketId: string;
  /** The seller's own zone, or null when none was chosen. */
  readonly timeZone: string | null;
  readonly permissionKeys: readonly string[];
  /** The session's CSRF token, sent with the saved-filter writes. */
  readonly csrfToken: string;
  /** The platform category tree for the Category filter; empty when it did not load. */
  readonly categories: CategoryTree['categories'];
  /** The Market's product types for the Product type filter; empty when they did not load. */
  readonly productTypes: readonly string[];
  /** The Market's "List paging" setting, Previous and next when it could not be read. */
  readonly paging: ListPagingMode;
}) {
  const t = useTranslations('catalog.products');
  const tl = useTranslations('load');
  const locale = useLocale();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const desktop = useDesktop();
  const query = useMemo(() => parseQuery(searchParams), [searchParams]);
  const queryRef = useRef(query);
  queryRef.current = query;
  const apiQuery = queryString(query);

  const [draft, setDraft] = useState(query.q);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const [answer, setAnswer] = useState<ProductsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(cleanColumns(undefined));
  const [sheet, setSheet] = useState<'filter' | 'sort' | null>(null);
  // The saved filters (catalog design 9.2d): null until they load, and when they cannot (the page
  // then has the built-in tabs only, and no Save filter or Manage filters).
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  // The saved filters were asked once (loaded or not): until then a saved tab cannot be told apart.
  const [savedSettled, setSavedSettled] = useState(false);
  const latest = useRef(0);
  const storageKey = prefsKey('seller', marketId, accountId, 'products-columns');
  const canEdit = permissionKeys.includes(EDIT_PERMISSION);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const loadSaved = useCallback(async () => {
    const result = await callApi<SavedFiltersAnswer>(
      'GET',
      `catalog/seller/saved-filters?listKey=${LIST_KEY}`,
    );
    if (result.ok) setSaved(result.body);
    setSavedSettled(true);
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  /** Moves the address to another list; the page is the first unless the patch names one. */
  const go = useCallback(
    (patch: Partial<Query>) => {
      const next = { ...queryRef.current, page: 1, ...patch };
      const text = addressOf(next);
      router.replace(text === '' ? pathname : `${pathname}?${text}`, { scroll: false });
    },
    [pathname, router],
  );

  const goRef = useRef(go);
  goRef.current = go;

  const load = useCallback(async (text: string) => {
    const ticket = ++latest.current;
    setLoading(true);
    setFailure(null);
    const result = await callApi<ProductsPage>('GET', `catalog/seller/products?${text}`);
    if (ticket !== latest.current) return;
    setLoading(false);
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      const kind = failureOf(
        result.failure.status,
        result.failure.code,
        result.failure.details?.fields ?? [],
      );
      // A link past the last page the API serves opens the first page instead.
      if (kind === 'range') {
        goRef.current({ page: 1 });
        return;
      }
      setFailure(kind);
      return;
    }
    setAnswer(result.body);
  }, []);

  useEffect(() => {
    void load(apiQuery);
  }, [load, apiQuery]);

  // A page past the last one (a stale link, or rows removed meanwhile) opens the last page.
  useEffect(() => {
    if (answer === null || loading || failure !== null) return;
    if (answer.items.length === 0 && answer.total > 0 && query.page > 1) {
      go({ page: lastPage(answer.total, query.pageSize) });
    }
  }, [answer, loading, failure, query.page, query.pageSize, go]);

  // Typing searches after a short pause; Enter does not wait.
  useEffect(() => {
    if (draft.trim() === query.q) return undefined;
    const timer = setTimeout(() => go({ q: draft.trim() }), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, query.q, go]);

  // The address changed by another way (Clear all, Back, a link): the box follows it.
  useEffect(() => {
    if (draftRef.current.trim() !== query.q) setDraft(query.q);
  }, [query.q]);

  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => {
    setDraft('');
    go({ q: '', filters: {} });
  };
  const withoutFilter = (field: (typeof FILTER_FIELDS)[number]): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const counts = answer?.counts ?? null;
  const filtered = isFiltered(query);
  const chipLabel = (field: (typeof FILTER_FIELDS)[number]): string | null => {
    const value = query.filters[field];
    if (value === undefined) return null;
    const shown =
      field === 'categoryId'
        ? (categories.find((category) => category.id === value)?.name ?? value)
        : field === 'status'
          ? t(`status.${value}`)
          : field === 'paused'
            ? t(`filter.paused.${value}`)
            : value;
    return t('chip', { field: t(`filter.name.${field}`), value: shown });
  };
  const chips = FILTER_FIELDS.flatMap((field) => {
    const label = chipLabel(field);
    return label === null ? [] : [{ field, label }];
  });

  // Another tab, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages (up to the cap of one export).
  const listKey = JSON.stringify([query.view, query.q, query.filters, query.sort, query.direction]);
  const pageIds = useMemo(() => answer?.items.map((item) => item.productId) ?? [], [answer]);
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
  // The first load failed: the load error in place of the list.
  const firstLoadError = answer === null && failure === 'unavailable';
  const skeleton = status.skeleton && failure === null;

  const canShare = saved?.canShare ?? permissionKeys.includes(SHARE_PERMISSION);
  const limits = saved?.limits ?? DEFAULT_LIMITS;
  // The saved filter on show is the one whose list this address is (a tab on its own wins).
  const activeSaved = isPlainView(query)
    ? undefined
    : saved?.items.find((item) => sameList(queryOf(item.payload, query.pageSize), query));
  // "Save filter" is offered when the list differs from every view, built in or saved.
  const canSave = saved !== null && filtered && activeSaved === undefined;
  const openSaved = (id: string) => {
    const filter = saved?.items.find((item) => item.id === id);
    if (filter === undefined) return;
    // `v` is the document's version; it never reaches the address.
    const next = queryOf(filter.payload, queryRef.current.pageSize);
    router.replace(addressOf(next) === '' ? pathname : `${pathname}?${addressOf(next)}`, {
      scroll: false,
    });
  };
  const summary = [
    t(`tab.${query.view}`),
    ...(query.q === '' ? [] : [t('saved.summary-search', { q: query.q })]),
    ...chips.map((chip) => chip.label),
    ...(query.sort === 'updated' && query.direction === 'desc'
      ? []
      : [
          t('saved.summary-sort', {
            field: t(`sort.field.${query.sort}`),
            order: t(`sort.${orderKey(query.sort, query.direction)}`),
          }),
        ]),
  ].join(' · ');

  const start = answer === null ? 0 : (answer.page - 1) * answer.pageSize;
  const sortName = t(`sort.field.${query.sort}`);
  const sortOrder = t(`sort.${orderKey(query.sort, query.direction)}`);
  const noProducts = counts !== null && counts.all === 0 && !filtered;
  // "On the platform" (Offer page design, section 3): under the list while the All tab has a search
  // and nothing else; a filter, a saved tab, another tab or a list error hides it. It waits for the
  // saved filters, so a saved tab never shows it for a moment.
  const showPlatform =
    canEdit &&
    savedSettled &&
    answer !== null &&
    failure === null &&
    query.q !== '' &&
    query.view === 'all' &&
    filterCount(query.filters) === 0 &&
    activeSaved === undefined;

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'package'}
      title={
        filtered
          ? t('empty.no-match')
          : noProducts || counts === null
            ? t('empty.none')
            : t(`empty.view.${query.view}`)
      }
      body={
        filtered
          ? t('empty.no-match-help')
          : noProducts || counts === null
            ? t('empty.none-help')
            : undefined
      }
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {t('clear-all')}
          </Button>
        ) : (noProducts || counts === null) && canEdit ? (
          <LinkButton href="/products/new">{t('add')}</LinkButton>
        ) : undefined
      }
    />
  );

  const filterPanel = (close: () => void) => (
    <ProductsFilterPanel
      filters={query.filters}
      categories={categories}
      productTypes={productTypes}
      onApply={(filters) => go({ filters })}
      close={close}
    />
  );
  const sortPanel = (
    <ProductsSortPanel
      sort={query.sort}
      direction={query.direction}
      onChange={(sort, direction) => go({ sort, direction })}
    />
  );
  const filterTotal = filterCount(query.filters);

  const toolbar = desktop ? (
    <fieldset disabled={skeleton} className="flex min-w-0 items-center gap-2">
      <Popover label={t('filter.button')} icon="sliders" count={filterTotal} width="lg">
        {filterPanel}
      </Popover>
      <Popover label={t('sort.button')} icon="arrow-down" width="sm">
        {() => sortPanel}
      </Popover>
      <Popover label={t('columns.button')} icon="columns" width="md">
        {(close) => <ProductsColumnsPanel columns={columns} onSave={saveColumns} close={close} />}
      </Popover>
    </fieldset>
  ) : (
    <fieldset disabled={skeleton} className="flex min-w-0 items-center gap-2">
      <IconButton
        icon="sliders"
        label={filterTotal > 0 ? `${t('filter.button')} (${filterTotal})` : t('filter.button')}
        aria-haspopup="dialog"
        onClick={() => setSheet('filter')}
      />
      <IconButton
        icon="arrow-down"
        label={t('sort.button')}
        aria-haspopup="dialog"
        onClick={() => setSheet('sort')}
      />
    </fieldset>
  );

  // Open and Edit go to the product; the server says which of them this seller may run.
  const rowActions = (row: ProductRow): readonly MenuItem[] => {
    const allowed = new Set(row.actions ?? []);
    const items: MenuItem[] = [];
    if (allowed.has('open'))
      items.push({
        id: 'open',
        label: t('row.menu.open'),
        onSelect: () => router.push(`/products/${row.productId}`),
      });
    if (allowed.has('edit'))
      items.push({
        id: 'edit',
        label: t('row.menu.edit'),
        onSelect: () => router.push(`/products/${row.productId}`),
      });
    return items;
  };

  return (
    <>
      <SuperList
        heading={{
          title: t('title'),
          actions: (
            <>
              <ProductsExport
                selection={{
                  ids: [...selection.selected],
                  allMatching: selection.allMatching,
                  // Rows kept after a failed refresh belong to another list than the address: no
                  // "select all matching" over them.
                  total: failure === null ? (answer?.total ?? 0) : 0,
                }}
                query={query}
                columns={columns}
                total={answer === null || failure !== null ? null : answer.total}
                timeZone={timeZone}
                onSelectAll={selection.selectAllMatching}
                onClear={selection.clear}
              />
              {canRunImport(permissionKeys) ? (
                <LinkButton variant="secondary" href="/products/import" className="gap-2">
                  <Icon name="file" />
                  {t('import')}
                </LinkButton>
              ) : null}
              {canEdit ? <AddOfferButton csrfToken={csrfToken} /> : null}
              {/* An empty store carries Add product in its empty state, so it is shown once. */}
              {canEdit && !noProducts ? (
                <LinkButton href="/products/new">{t('add')}</LinkButton>
              ) : null}
            </>
          ),
        }}
        notice={
          canEdit ? null : (
            <Banner tone="info" title={t('view-only.title')}>
              <p>{t('view-only.body')}</p>
            </Banner>
          )
        }
        views={{
          label: t('tabs'),
          activeId: activeSaved?.id ?? query.view,
          onSelect: (id) => {
            if (saved?.items.some((item) => item.id === id)) openSaved(id);
            else if (activeSaved !== undefined) {
              // A saved filter belongs to its own tab: a built-in tab opens as it is, without the
              // saved filter's search, filters or sort. The search box follows the address.
              go({ ...DEFAULT_QUERY, view: id as View, pageSize: query.pageSize });
            } else go({ view: id as View });
          },
          items: [
            ...VIEWS.map((view) => ({
              id: view,
              label: `${t(`tab.${view}`)}${counts === null ? '' : ` (${number(countOf(counts, view))})`}`,
            })),
            ...(saved?.items ?? []).map((item) => ({ id: item.id, label: item.name })),
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
          onSubmit: (value) => go({ q: value }),
        }}
        toolbar={toolbar}
        sortedLine={t('sorted', { field: sortName, order: sortOrder })}
        chips={
          filtered || canSave
            ? {
                chips: chips.map((chip) => ({
                  key: chip.field,
                  label: chip.label,
                  removeLabel: t('chip-remove', { filter: chip.label }),
                  onRemove: () => go({ filters: withoutFilter(chip.field) }),
                })),
                ...(filtered ? { clearAll: { label: t('clear-all'), onClick: clearAll } } : {}),
                ...(canSave
                  ? { save: { label: t('saved.save-link'), onClick: () => setDialog('save') } }
                  : {}),
                status:
                  !filtered || answer === null || failure !== null
                    ? ''
                    : t('match', { count: answer.total }),
              }
            : null
        }
        failure={
          failure === null
            ? null
            : {
                ...(failure === 'unavailable' ? { title: t('error.title') } : {}),
                message: t(`error.${failure}`),
                ...(failure === 'unavailable'
                  ? { retry: { label: tl('retry'), onClick: () => void load(apiQuery) } }
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
            // Rows kept after a failed refresh belong to another list than the address.
            actions={failure === null ? rowActions : noActions}
            selection={selection}
          />
        }
        pagination={
          answer !== null && answer.total > 0
            ? {
                mode: paging,
                page: answer.page,
                pageSize: answer.pageSize,
                pageSizes: PAGE_SIZES,
                total: answer.total,
                maxRows: MAX_LIST_ROWS,
                range: t('range', {
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
                onPage: (page) => go({ page }),
                onPageSize: (pageSize) => go({ pageSize }),
              }
            : null
        }
        dialogs={
          <>
            <SaveFilterDialog
              open={dialog === 'save'}
              onClose={() => setDialog(null)}
              query={query}
              summary={summary}
              canShare={canShare}
              limits={limits}
              csrfToken={csrfToken}
              onSaved={() => void loadSaved()}
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
      {showPlatform ? <OnThePlatform text={query.q} csrfToken={csrfToken} /> : null}
      <BottomSheet
        open={!desktop && sheet === 'filter'}
        title={t('filter.title')}
        closeLabel={t('sheet-close')}
        onClose={() => setSheet(null)}
      >
        {/* The sheet's own title names it; the panel's heading would repeat it. */}
        <div className="[&_h2]:sr-only">{filterPanel(() => setSheet(null))}</div>
      </BottomSheet>
      <BottomSheet
        open={!desktop && sheet === 'sort'}
        title={t('sort.button')}
        closeLabel={t('sheet-close')}
        onClose={() => setSheet(null)}
      >
        {sortPanel}
      </BottomSheet>
    </>
  );
}
