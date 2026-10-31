'use client';

import {
  Banner,
  Button,
  EmptyState,
  FilterChip,
  Icon,
  Popover,
  SearchField,
  SkeletonRows,
  Tabs,
  browserStorage,
  prefsKey,
  readIds,
  writeIds,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
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
import { ProductsSortPanel } from './products-sort-panel.tsx';
import { ProductsTable } from './products-table.tsx';
import {
  BULK_MAX_IDS,
  DEFAULT_COLUMNS,
  DEFAULT_QUERY,
  FILTER_FIELDS,
  SEARCH_MAX,
  VIEWS,
  cleanColumns,
  filterCount,
  orderKey,
  queryString,
  type CategoryTree,
  type Filters,
  type OptionalColumn,
  type ProductsPage,
  type Query,
  type View,
} from './products-types.ts';

type Failure = 'denied' | 'too-broad' | 'unavailable';

const SEARCH_DELAY_MS = 300;

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
  timeZone,
  permissionKeys,
  csrfToken,
}: {
  readonly accountId: string;
  readonly marketId: string;
  readonly timeZone: string;
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.products');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [query, setQuery] = useState<Query>(DEFAULT_QUERY);
  const [draft, setDraft] = useState('');
  const [answer, setAnswer] = useState<ProductsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [categories, setCategories] = useState<CategoryTree['categories']>([]);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [allMatching, setAllMatching] = useState(false);
  // The saved views (catalog design 9.2d): null until they load, and when they cannot (the page
  // then has the three fixed tabs only). `savedId` is the saved tab the page is showing.
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
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
    // A saved view that was deleted (here or by its owner) is no longer the one on show.
    setSavedId((current) =>
      current !== null && result.body.items.some((item) => item.id === current) ? current : null,
    );
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

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

  // Typing searches after a short pause; Enter does not wait.
  useEffect(() => {
    if (draft.trim() === query.q) return undefined;
    const timer = setTimeout(() => {
      setSavedId(null);
      setQuery((current) => ({ ...current, q: draft.trim(), page: 1 }));
    }, SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [draft, query.q]);

  // A new tab, search, filter or sort is another list: the selection does not follow it. Paging
  // keeps it, so rows can be ticked on several pages.
  const listKey = JSON.stringify([query.view, query.q, query.filters, query.sort, query.direction]);
  useEffect(() => {
    setSelected(new Set());
    setAllMatching(false);
  }, [listKey]);

  const pageIds = answer?.items.map((item) => item.productId) ?? [];
  const toggleRow = (productId: string) => {
    if (allMatching) {
      // Leaving "all in this filter": the rows of this page stay ticked, except this one.
      setAllMatching(false);
      setSelected(new Set(pageIds.filter((id) => id !== productId)));
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(productId)) next.delete(productId);
      else if (next.size < BULK_MAX_IDS) next.add(productId);
      return next;
    });
  };
  const togglePage = (checked: boolean) => {
    if (allMatching) {
      if (!checked) {
        setAllMatching(false);
        setSelected(new Set());
      }
      return;
    }
    setSelected((current) => {
      const next = new Set(current);
      for (const id of pageIds) {
        if (!checked) next.delete(id);
        else if (next.size < BULK_MAX_IDS) next.add(id);
      }
      return next;
    });
  };
  const clearSelection = () => {
    setSelected(new Set());
    setAllMatching(false);
  };

  // Any change of the tab, search, filters or sort leaves the saved view (it is no longer it).
  const change = (patch: Partial<Query>) => {
    setSavedId(null);
    setQuery((current) => ({ ...current, page: 1, ...patch }));
  };
  const openSaved = (id: string) => {
    const filter = saved?.items.find((item) => item.id === id);
    if (filter === undefined) return;
    const next = queryOf(filter.payload);
    setSavedId(id);
    setDraft(next.q);
    setQuery(next);
  };
  const saveColumns = (next: readonly OptionalColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => {
    setDraft('');
    change({ q: '', filters: {} });
  };
  const withoutFilter = (field: (typeof FILTER_FIELDS)[number]): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== field));

  const canShare = saved?.canShare ?? permissionKeys.includes(SHARE_PERMISSION);
  const limits = saved?.limits ?? { perOwner: 50, shared: 20 };

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const counts = answer?.counts ?? null;
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

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'package'}
      title={
        filtered
          ? t('empty.no-match')
          : counts !== null && counts.all > 0
            ? t(`empty.view.${query.view}`)
            : t('empty.none')
      }
      body={
        filtered
          ? t('empty.no-match-help')
          : counts !== null && counts.all > 0
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <p className="min-w-0 text-sm text-fg-muted">
          {counts === null ? '' : t('subtitle', { count: counts.all, market: marketId })}
        </p>
        <ProductsBulk
          selection={{ ids: [...selected], allMatching, total: answer?.total ?? 0 }}
          query={query}
          columns={columns}
          permissionKeys={permissionKeys}
          csrfToken={csrfToken}
          onSelectAll={() => setAllMatching(true)}
          onClear={clearSelection}
          onChanged={() => {
            clearSelection();
            void load(query);
            void loadSaved();
          }}
        />
      </div>
      <div className="flex items-stretch">
        <div className="min-w-0 flex-1">
          <Tabs
            label={t('tabs')}
            activeId={savedId ?? query.view}
            onSelect={(id) => {
              if (saved?.items.some((item) => item.id === id)) openSaved(id);
              else change({ view: id as View });
            }}
            items={[
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
            ]}
          />
        </div>
        {saved === null ? null : (
          <div className="flex shrink-0 items-center border-b border-line ps-3">
            <Button
              variant="link"
              className="min-h-(--mp-size-control-sm)"
              onClick={() => setDialog('manage')}
            >
              <Icon name="sliders" />
              <span className="sr-only sm:not-sr-only">{t('saved.manage-link')}</span>
            </Button>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <SearchField
          label={t('search.label')}
          placeholder={t('search.placeholder')}
          value={draft}
          maxLength={SEARCH_MAX}
          className="w-full min-w-0 sm:min-w-64 sm:max-w-110 sm:flex-1"
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') change({ q: draft.trim() });
          }}
        />
        <div className="flex items-center gap-2">
          <Popover
            label={t('filter.button')}
            icon="sliders"
            count={filterCount(query.filters)}
            width="lg"
          >
            {(close) => (
              <ProductsFilterPanel
                filters={query.filters}
                categories={categories}
                onApply={(filters) => change({ filters })}
                close={close}
              />
            )}
          </Popover>
          <Popover label={t('sort.button')} icon="arrow-down" width="sm">
            {() => (
              <ProductsSortPanel
                sort={query.sort}
                direction={query.direction}
                onChange={(sort, direction) => change({ sort, direction })}
              />
            )}
          </Popover>
          <Popover label={t('columns.button')} icon="columns" width="md">
            {(close) => (
              <ProductsColumnsPanel columns={columns} onSave={saveColumns} close={close} />
            )}
          </Popover>
        </div>
        <p className="text-sm text-fg-muted sm:ms-auto">
          {t('sorted', { field: sortName, order: sortOrder })}
        </p>
      </div>
      {filtered ? (
        <div className="flex flex-wrap items-center gap-2">
          {chips.map((chip) => (
            <FilterChip
              key={chip.field}
              label={chip.label}
              removeLabel={t('chip-remove', { filter: chip.label })}
              onRemove={() => change({ filters: withoutFilter(chip.field) })}
            />
          ))}
          <Button variant="link" className="min-h-(--mp-size-control-sm)" onClick={clearAll}>
            {t('clear-all')}
          </Button>
          {saved === null || savedId !== null ? null : (
            <Button
              variant="link"
              className="min-h-(--mp-size-control-sm)"
              onClick={() => setDialog('save')}
            >
              <Icon name="star" />
              {t('saved.save-link')}
            </Button>
          )}
          <p role="status" className="text-sm font-medium text-fg-secondary sm:ms-auto">
            {answer === null || failure !== null ? '' : t('match', { count: answer.total })}
          </p>
        </div>
      ) : null}
      {failure === null ? null : (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t(`error.${failure}`)}</span>
            {failure === 'unavailable' ? (
              <Button variant="secondary" onClick={() => void load(query)}>
                {tl('retry')}
              </Button>
            ) : null}
          </div>
        </Banner>
      )}
      {loading && (answer === null || failure !== null) ? (
        <SkeletonRows label={t('loading')} rows={4} />
      ) : null}
      {answer !== null && failure === null ? (
        <div className={loading ? 'opacity-60' : undefined} aria-busy={loading}>
          <ProductsTable
            rows={answer.items}
            columns={columns}
            timeZone={timeZone}
            empty={empty}
            selection={{
              selected,
              allMatching,
              full: !allMatching && selected.size >= BULK_MAX_IDS,
              onToggle: toggleRow,
              onTogglePage: togglePage,
            }}
          />
        </div>
      ) : null}
      {answer !== null && failure === null && answer.total > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm text-fg-muted">
            {t('range', {
              from: number(start + 1),
              to: number(start + answer.items.length),
              total: number(answer.total),
            })}
          </p>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              disabled={loading || answer.page <= 1}
              onClick={() => setQuery((current) => ({ ...current, page: current.page - 1 }))}
            >
              {t('previous')}
            </Button>
            <Button
              variant="secondary"
              disabled={loading || start + answer.items.length >= answer.total}
              onClick={() => setQuery((current) => ({ ...current, page: current.page + 1 }))}
            >
              {t('next')}
            </Button>
          </div>
        </div>
      ) : null}
      <SaveFilterDialog
        open={dialog === 'save'}
        onClose={() => setDialog(null)}
        query={query}
        summary={summary}
        canShare={canShare}
        limits={limits}
        csrfToken={csrfToken}
        onSaved={(filter) => {
          void loadSaved().then(() => setSavedId(filter.id));
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
    </div>
  );
}
