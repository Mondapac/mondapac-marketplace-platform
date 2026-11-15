'use client';

import {
  Badge,
  Button,
  EmptyState,
  ListColumnsPanel,
  ListSortPanel,
  SuperList,
  SuperTable,
  browserStorage,
  prefsKey,
  readIds,
  toast,
  useRowSelection,
  useSuperListQuery,
  writeIds,
  type MenuItem,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { formatMinor } from '../wallet/money.ts';
import { CustomerStatusDialog, type StatusTarget } from './customer-status.tsx';
import { CustomersBulk } from './customers-bulk.tsx';
import { CustomersFilterPanel } from './customers-filter-panel.tsx';
import { CustomersSavedDialogs } from './customers-saved.tsx';
import { dayOf } from './format.ts';
import {
  DEFAULT_COLUMNS,
  DEFAULT_QUERY,
  FILTER_KEYS,
  LIST_KEY,
  OPTIONAL_COLUMNS,
  PAGE_SIZES,
  SEARCH_MAX,
  SEARCH_MIN,
  SELECT_MAX,
  SHARE_PERMISSION,
  SORTS,
  STATUS_PERMISSION,
  VIEWS,
  cleanColumns,
  defaultDirection,
  filterCount,
  queryOfPayload,
  selectorOf,
  titleOf,
  type CustomerRow,
  type CustomersPage,
  type FilterKey,
  type Filters,
  type OptionalColumn,
  type Query,
  type SavedFiltersAnswer,
  type Sort,
  type View,
} from './list-types.ts';

type Failure = 'denied' | 'invalid' | 'unavailable';

/** Copies text and says so in a toast (announced); the focus stays where it was. */
export async function copyText(text: string, done: string, failed: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done, { id: 'customers-copy' });
  } catch {
    toast.error(failed, { id: 'customers-copy' });
  }
}

/**
 * The admin Customers list (customers management phase 1, F1), a super list: the seven tabs with
 * their counts and the saved filters, search by the start of the email or a part of the name,
 * the filter, sort and column panels, the chips, row selection with "select all matching", the
 * Bulk action menu (Export), the row Actions menu, and the footer of the Market's List paging
 * setting. The column choice is the admin's own, in this browser. Every answer is personal data:
 * nothing is kept beyond the page.
 */
export function CustomersList({
  accountId,
  marketId,
  marketName,
  zone,
  paging,
  permissionKeys,
  csrfToken,
}: {
  readonly accountId: string;
  readonly marketId: string;
  readonly marketName: string;
  /** The IANA zone the dates read in (ADR-0005). */
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('customers.list');
  const tc = useTranslations('customers');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [answer, setAnswer] = useState<CustomersPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState<SavedFiltersAnswer | null>(null);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const [columns, setColumns] = useState<readonly OptionalColumn[]>(DEFAULT_COLUMNS);
  const [statusTarget, setStatusTarget] = useState<StatusTarget | null>(null);
  // The Market's currency, as the rows carry it: the spent filter is typed in it.
  const [currency, setCurrency] = useState<string | null>(null);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'customers-columns');

  const list = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView: (view) => ({ ...DEFAULT_QUERY, view: view as View }),
    withView: (current, view) => ({ ...current, view: view as View }),
    searchOf: (current) => current.q,
    withSearch: (current, q) => ({ ...current, q }),
  });
  const { query } = list;
  const shortSearch = list.draft.trim().length > 0 && list.draft.trim().length < SEARCH_MIN;

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const loadSaved = useCallback(async (): Promise<SavedFiltersAnswer | null> => {
    const result = await callApi<SavedFiltersAnswer>(
      'GET',
      `customers/admin/saved-filters?listKey=${LIST_KEY}`,
    );
    if (!result.ok) return null;
    setSaved(result.body);
    return result.body;
  }, []);

  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const load = useCallback(
    async (next: Query) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<CustomersPage>(
        'POST',
        'customers/admin/list',
        {
          ...selectorOf(next),
          sort: next.sort,
          direction: next.direction,
          page: next.page,
          pageSize: next.pageSize,
        },
        csrfToken,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailure(
          result.failure.status === 403
            ? 'denied'
            : result.failure.code === 'validation.failed'
              ? 'invalid'
              : 'unavailable',
        );
        return;
      }
      setAnswer(result.body);
      const known = result.body.items.find((row) => row.currency !== null)?.currency ?? null;
      if (known !== null) setCurrency(known);
    },
    [csrfToken],
  );

  useEffect(() => {
    void load(query);
  }, [load, query]);

  // A new tab, search, filter or sort is another list: the selection does not follow it.
  const selectionKey = JSON.stringify([
    query.view,
    query.q,
    query.filters,
    query.sort,
    query.direction,
  ]);
  const pageIds = useMemo(() => answer?.items.map((row) => row.accountId) ?? [], [answer]);
  const selection = useRowSelection(pageIds, SELECT_MAX, selectionKey);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const money = (row: CustomerRow) =>
    row.orderCount === 0 || row.currency === null
      ? '—'
      : formatMinor(row.spentMinor, row.currency, locale);
  const counts = answer?.counts ?? null;
  const total = answer?.paging?.total ?? 0;
  const filtered = query.q.trim() !== '' || filterCount(query.filters) > 0;

  const chipValue = (key: FilterKey, value: string): string => {
    if (key === 'status') return tc(`status.${value}`);
    if (key === 'verified') return t(`filter.verified.${value}`);
    if (key === 'spentMin' || key === 'spentMax') {
      return currency === null ? value : formatMinor(value, currency, locale);
    }
    if (key === 'ordersMin' || key === 'ordersMax') return number(Number(value));
    return value;
  };
  const chips = FILTER_KEYS.flatMap((key) => {
    const value = query.filters[key];
    if (value === undefined) return [];
    const label = t('chip', { field: t(`filter.chip.${key}`), value: chipValue(key, value) });
    return [{ key, label }];
  });
  const withoutFilter = (key: FilterKey): Filters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== key));
  const clearAll = () => list.reset({ q: '', filters: {} });

  const summary = [
    t(`tab.${query.view}`),
    ...(query.q.trim() === '' ? [] : [t('saved.summary-search', { q: query.q.trim() })]),
    ...chips.map((chip) => chip.label),
  ].join(' · ');

  const canShare = saved?.canShare ?? permissionKeys.includes(SHARE_PERMISSION);
  const limits = saved?.limits ?? { perOwner: 50, shared: 20 };
  const canChangeStatus = permissionKeys.includes(STATUS_PERMISSION);

  const optionalColumn = (id: OptionalColumn): SuperColumn<CustomerRow> => {
    switch (id) {
      case 'status':
        return {
          id,
          header: t('col.status'),
          corner: true,
          cell: (row) => (
            <Badge tone={row.status === 'active' ? 'success' : 'critical'}>
              {tc(`status.${row.status}`)}
            </Badge>
          ),
        };
      case 'joined':
        return { id, header: t('col.joined'), cell: (row) => dayOf(row.signedUpAt, locale, zone) };
      case 'orders':
        return {
          id,
          header: t('col.orders'),
          numeric: true,
          cell: (row) => number(row.orderCount),
        };
      case 'spent':
        return { id, header: t('col.spent'), numeric: true, cell: money };
      case 'last-order':
        return {
          id,
          header: t('col.last-order'),
          cell: (row) =>
            row.lastOrderAt === null ? (
              <span className="text-fg-muted">{t('never')}</span>
            ) : (
              dayOf(row.lastOrderAt, locale, zone)
            ),
        };
      case 'verified':
        return {
          id,
          header: t('col.verified'),
          cell: (row) => tc(row.emailVerified ? 'yes' : 'no'),
        };
      case 'refunds':
        return {
          id,
          header: t('col.refunds'),
          numeric: true,
          cell: (row) => number(row.refundCount),
        };
    }
  };

  const tableColumns: SuperColumn<CustomerRow>[] = [
    {
      id: 'customer',
      header: t('col.customer'),
      primary: true,
      headClassName: 'min-w-56',
      cell: (row) => {
        const named = titleOf(row) !== row.email;
        return (
          <div className="flex min-w-0 flex-col">
            <a
              href={`/customers/${encodeURIComponent(row.accountId)}`}
              className="font-medium text-fg wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-focus"
            >
              {titleOf(row)}
            </a>
            {named ? <span className="text-fg-muted wrap-anywhere">{row.email}</span> : null}
          </div>
        );
      },
    },
    ...columns.map(optionalColumn),
  ];

  const rowItems = (row: CustomerRow): MenuItem[] => [
    {
      id: 'open',
      label: t('row.open'),
      onSelect: () => window.location.assign(`/customers/${encodeURIComponent(row.accountId)}`),
    },
    {
      id: 'copy-email',
      label: t('row.copy-email'),
      icon: 'clipboard',
      onSelect: () => void copyText(row.email, t('copied'), t('copy-failed')),
    },
    {
      id: 'copy-id',
      label: t('row.copy-id'),
      icon: 'clipboard',
      onSelect: () => void copyText(row.accountId, t('copied'), t('copy-failed')),
    },
    ...(canChangeStatus
      ? [
          {
            id: 'status',
            label: row.status === 'active' ? t('row.disable') : t('row.enable'),
            ...(row.status === 'active' ? { tone: 'critical' as const } : {}),
            icon: row.status === 'active' ? ('ban' as const) : ('check' as const),
            onSelect: () =>
              setStatusTarget({ accountId: row.accountId, email: row.email, status: row.status }),
          },
        ]
      : []),
  ];

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'users'}
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
            {t('clear-filters')}
          </Button>
        ) : undefined
      }
    />
  );

  const savedItems = saved?.items ?? [];
  const pageSize = answer?.paging?.pageSize ?? query.pageSize;
  const start =
    answer?.paging === null || answer === null ? 0 : (answer.paging.page - 1) * pageSize;
  const sortOrder = (sort: Sort): readonly [string, string] =>
    sort === 'name' || sort === 'email'
      ? [t('sort.name.first'), t('sort.name.second')]
      : sort === 'joined' || sort === 'last-order'
        ? [t('sort.date.first'), t('sort.date.second')]
        : [t('sort.figure.first'), t('sort.figure.second')];

  return (
    <SuperList
      heading={{
        subtitle: counts === null ? '' : t('subtitle', { count: counts.all, market: marketName }),
        actions: (
          <CustomersBulk
            selection={{
              ids: [...selection.selected],
              allMatching: selection.allMatching,
              total: failure === null ? total : 0,
            }}
            query={query}
            columns={columns}
            permissionKeys={permissionKeys}
            csrfToken={csrfToken}
            onSelectAll={selection.selectAllMatching}
            onClear={selection.clear}
          />
        ),
      }}
      views={{
        label: t('tabs'),
        activeId: list.savedId ?? query.view,
        onSelect: (id) => {
          const filter = savedItems.find((item) => item.id === id);
          if (filter !== undefined)
            list.openSaved(id, queryOfPayload(filter.payload, query.pageSize));
          else list.openView(id);
        },
        items: [
          ...VIEWS.map((view) => ({
            id: view,
            label: `${t(`tab.${view}`)}${counts === null ? '' : ` (${number(counts[view])})`}`,
          })),
          ...savedItems.map((item) => {
            const count = item.id === list.savedId ? total : (item.count ?? null);
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
        value: list.draft,
        maxLength: SEARCH_MAX,
        onChange: list.setDraft,
        onSubmit: (value) => list.change({ q: value }),
      }}
      filter={{
        label: t('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <CustomersFilterPanel
            filters={query.filters}
            currency={currency}
            onApply={(filters) => list.change({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: t('sort.button'),
        panel: () => (
          <ListSortPanel
            name="customers-sort"
            sort={query.sort}
            direction={query.direction}
            fields={SORTS.map((sort) => ({ id: sort, label: t(`sort.field.${sort}`) }))}
            defaultDirection={(sort) => defaultDirection(sort as Sort)}
            orderLabels={(sort) => sortOrder(sort as Sort)}
            labels={{ by: t('sort.by'), order: t('sort.order') }}
            onChange={(sort, direction) => list.change({ sort: sort as Sort, direction })}
          />
        ),
      }}
      columns={{
        label: t('columns.button'),
        panel: (close) => (
          <ListColumnsPanel
            columns={columns}
            optional={OPTIONAL_COLUMNS}
            defaults={DEFAULT_COLUMNS}
            fixed={[{ id: 'customer', label: t('col.customer') }]}
            optionalLabel={(column) => t(`col.${column}`)}
            labels={{
              title: t('columns.title'),
              help: t('columns.help'),
              always: t('columns.always'),
              up: (column) => t('columns.up', { column }),
              down: (column) => t('columns.down', { column }),
              reset: t('columns.reset'),
              save: t('columns.save'),
            }}
            onSave={(next) => {
              const clean = cleanColumns(next);
              setColumns(clean);
              writeIds(browserStorage(), storageKey, clean);
            }}
            close={close}
          />
        ),
      }}
      sortedLine={t('sorted', {
        field: t(`sort.field.${query.sort}`),
        order: sortOrder(query.sort)[query.direction === defaultDirection(query.sort) ? 0 : 1],
      })}
      chips={
        filtered || shortSearch
          ? {
              chips: chips.map((chip) => ({
                key: chip.key,
                label: chip.label,
                removeLabel: t('chip-remove', { filter: chip.label }),
                onRemove: () => list.change({ filters: withoutFilter(chip.key) }),
              })),
              clearAll: filtered ? { label: t('clear-all'), onClick: clearAll } : undefined,
              save:
                saved === null || list.savedId !== null || !filtered
                  ? undefined
                  : { label: t('saved.save-link'), onClick: () => setDialog('save') },
              status: shortSearch
                ? t('search.too-short', { min: SEARCH_MIN })
                : answer === null || failure !== null
                  ? ''
                  : t('match', { count: total }),
            }
          : null
      }
      failure={
        failure === null
          ? null
          : {
              message: t(`error.${failure}`),
              ...(failure === 'unavailable'
                ? { retry: { label: tl('retry'), onClick: () => void load(query) } }
                : {}),
            }
      }
      loading={loading}
      loadingLabel={t('loading')}
      ready={answer !== null}
      table={
        <SuperTable
          caption={t('caption')}
          rows={answer?.items ?? []}
          rowId={(row) => row.accountId}
          rowName={titleOf}
          columns={tableColumns}
          selection={{
            state: selection,
            labels: {
              page: t('select.page'),
              pageShort: t('select.page-short'),
              row: (name) => t('select.row', { name }),
            },
          }}
          actions={{
            header: t('col.actions'),
            label: (name) => t('row.menu', { name }),
            items: rowItems,
          }}
          empty={empty}
          minWidthClass="lg:min-w-200"
        />
      }
      pagination={
        answer === null || answer.paging === null || total === 0
          ? null
          : {
              mode: paging,
              page: answer.paging.page,
              pageSize,
              pageSizes: PAGE_SIZES,
              total,
              maxRows: answer.paging.maxRows,
              range: t('range', {
                from: number(start + 1),
                to: number(start + answer.items.length),
                total: number(total),
              }),
              labels: {
                rowsPerPage: t('paging.rows-per-page'),
                previous: t('paging.previous'),
                next: t('paging.next'),
                pages: t('paging.pages'),
                page: (page) => t('paging.page', { page }),
                narrowTitle: t('paging.narrow-title'),
                narrowBody: t('paging.narrow-body'),
              },
              disabled: loading,
              onPage: list.goToPage,
              onPageSize: (size) => list.change({ pageSize: size }),
            }
      }
      dialogs={
        <>
          <CustomersSavedDialogs
            dialog={dialog}
            onClose={() => setDialog(null)}
            query={query}
            summary={summary}
            filters={savedItems}
            canShare={canShare}
            limits={limits}
            csrfToken={csrfToken}
            onSaved={(filter) => {
              void loadSaved().then(() => list.openSaved(filter.id, query));
            }}
            onChanged={() => {
              const showing = list.savedId;
              void loadSaved().then((next) => {
                // A saved tab that was deleted is no longer the one on show.
                if (
                  showing !== null &&
                  next !== null &&
                  !next.items.some((item) => item.id === showing)
                ) {
                  list.forgetSaved();
                }
              });
            }}
          />
          <CustomerStatusDialog
            target={statusTarget}
            csrfToken={csrfToken}
            onClose={() => setStatusTarget(null)}
            onChanged={() => void load(query)}
          />
        </>
      }
    />
  );
}
