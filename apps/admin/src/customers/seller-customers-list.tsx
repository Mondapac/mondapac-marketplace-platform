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
  listSkeletonRowCount,
  prefsKey,
  readIds,
  useListLoading,
  useSuperListQuery,
  writeIds,
  type MenuItem,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { formatMinor } from '../wallet/money.ts';
import { copyText } from './customers-list.tsx';
import { dayOf } from './format.ts';
import { minutesOf } from './security-shared.tsx';
import { SellerCustomersFilterPanel } from './seller-customers-filter-panel.tsx';
import {
  CODE_SEARCH_MAX,
  CODE_SEARCH_MIN,
  DEFAULT_SELLER_QUERY,
  SELLER_OPTIONAL_COLUMNS,
  SELLER_PAGE_SIZES,
  SELLER_SORTS,
  SELLER_VIEWS,
  codeSearchOf,
  codeTerm,
  defaultSellerDirection,
  sellerBodyOf,
  sellerFilterCount,
  type SellerCustomerRow,
  type SellerCustomersPage,
  type SellerFilterKey,
  type SellerFilters,
  type SellerOptionalColumn,
  type SellerQuery,
  type SellerSort,
  type SellerView,
} from './seller-customers-types.ts';

type Failure = 'denied' | 'invalid' | 'unavailable' | { readonly throttled: number };

const DEFAULT_COLUMNS: readonly SellerOptionalColumn[] = [];

const cleanColumns = (
  stored: readonly string[] | null | undefined,
): readonly SellerOptionalColumn[] =>
  stored === null || stored === undefined
    ? DEFAULT_COLUMNS
    : stored.filter((id): id is SellerOptionalColumn =>
        (SELLER_OPTIONAL_COLUMNS as readonly string[]).includes(id),
      );

/**
 * A seller's customers in the admin panel (customers management phase 3), a super list: the four
 * views with their counts, search by the start of the customer code, the filter, sort and column
 * panels with removable chips, and the footer of the Market's List paging setting; on a phone the
 * rows are cards. Known exceptions (the API has no route for them): saved filters, row selection
 * and export. The admin sees the per-seller code and first name, and opens the customer's own page.
 * A 403 hides the whole section.
 */
export function SellerCustomersList({
  sellerId,
  accountId,
  marketId,
  zone,
  paging,
  csrfToken,
  onDenied,
}: {
  readonly sellerId: string;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone the dates read in (ADR-0005). */
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly csrfToken: string;
  readonly onDenied?: () => void;
}) {
  const t = useTranslations('customers.seller-tab.list');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [answer, setAnswer] = useState<SellerCustomersPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [columns, setColumns] = useState<readonly SellerOptionalColumn[]>(DEFAULT_COLUMNS);
  const [currency, setCurrency] = useState<string | null>(null);
  const latest = useRef(0);
  const storageKey = prefsKey('admin', marketId, accountId, 'seller-customers-columns');

  const list = useSuperListQuery<SellerQuery>({
    defaultQuery: DEFAULT_SELLER_QUERY,
    forView: (view) => ({ ...DEFAULT_SELLER_QUERY, view: view as SellerView }),
    withView: (current, view) => ({ ...current, view: view as SellerView }),
    searchOf: (current) => current.q,
    withSearch: (current, q) => ({ ...current, q }),
  });
  const { query } = list;
  const typed = codeTerm(list.draft.trim());
  const shortSearch = typed.length > 0 && typed.length < CODE_SEARCH_MIN;

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const load = useCallback(
    async (next: SellerQuery) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<SellerCustomersPage>(
        'POST',
        `customers/admin/sellers/${encodeURIComponent(sellerId)}/customers/list`,
        sellerBodyOf(next),
        csrfToken,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        if (result.failure.status === 403) {
          setFailure('denied');
          onDenied?.();
          return;
        }
        setFailure(
          result.failure.status === 429
            ? { throttled: minutesOf(result.failure, 60) }
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
    [csrfToken, sellerId, onDenied],
  );

  useEffect(() => {
    void load(query);
  }, [load, query]);

  const status = useListLoading(loading, answer !== null);
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure('unavailable');
  }, [status.stalled]);
  const firstLoadError = answer === null && failure !== null && failure !== 'denied';
  const skeleton = status.skeleton && failure === null;

  if (failure === 'denied') return null;

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const counts = answer?.counts ?? null;
  const total = answer?.paging?.total ?? 0;
  const filtered = codeSearchOf(query.q) !== undefined || sellerFilterCount(query.filters) > 0;

  const chipValue = (key: SellerFilterKey, value: string): string => {
    if (key === 'follower' || key === 'exclusive') return t(`filter.${value}`);
    if (key === 'spentMin' || key === 'spentMax') {
      return currency === null
        ? t('filter.minor-units', { value: Number(value) })
        : formatMinor(value, currency, locale);
    }
    if (key === 'ordersMin' || key === 'ordersMax') return number(Number(value));
    return value;
  };
  const withoutFilter = (key: SellerFilterKey): SellerFilters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== key));
  const chips = (Object.keys(query.filters) as SellerFilterKey[]).flatMap((key) => {
    const value = query.filters[key];
    if (value === undefined) return [];
    const label = t('chip', { field: t(`filter.chip.${key}`), value: chipValue(key, value) });
    return [{ key, label, patch: { filters: withoutFilter(key) } }];
  });
  const clearAll = () => list.reset({ q: '', filters: {} });

  const money = (row: SellerCustomerRow) =>
    row.spentMinor === null || row.currency === null
      ? '—'
      : formatMinor(row.spentMinor, row.currency, locale);
  const when = (iso: string | null) =>
    iso === null ? <span className="text-fg-muted">—</span> : dayOf(iso, locale, zone);

  const badges = (row: SellerCustomerRow) => {
    const found = [
      ...(row.orderCount > 0 ? [{ id: 'buyer', tone: 'success' as const }] : []),
      ...(row.follower ? [{ id: 'follower', tone: 'info' as const }] : []),
      ...(row.exclusive ? [{ id: 'exclusive', tone: 'attention' as const }] : []),
    ];
    return found.length === 0 ? (
      <span className="text-fg-muted">—</span>
    ) : (
      <span className="flex flex-wrap gap-1">
        {found.map((badge) => (
          <Badge key={badge.id} tone={badge.tone}>
            {t(`badge.${badge.id}`)}
          </Badge>
        ))}
      </span>
    );
  };

  const optionalColumn = (id: SellerOptionalColumn): SuperColumn<SellerCustomerRow> =>
    id === 'first-order'
      ? { id, header: t('col.first-order'), cell: (row) => when(row.firstOrderAt) }
      : { id, header: t('col.followed'), cell: (row) => when(row.followedAt) };

  const tableColumns: SuperColumn<SellerCustomerRow>[] = [
    {
      id: 'code',
      header: t('col.code'),
      primary: true,
      cell: (row) => (
        <a
          href={`/customers/${encodeURIComponent(row.accountId)}`}
          className="font-mono font-medium text-fg hover:underline focus-visible:outline-2 focus-visible:outline-focus"
        >
          {row.code}
        </a>
      ),
    },
    {
      id: 'first-name',
      header: t('col.first-name'),
      cell: (row) => row.firstName ?? <span className="text-fg-muted">—</span>,
    },
    { id: 'orders', header: t('col.orders'), numeric: true, cell: (r) => number(r.orderCount) },
    { id: 'spent', header: t('col.spent'), numeric: true, cell: money },
    { id: 'last-order', header: t('col.last-order'), cell: (row) => when(row.lastOrderAt) },
    { id: 'badges', header: t('col.badges'), cell: badges },
    ...columns.map(optionalColumn),
  ];

  const rowItems = (row: SellerCustomerRow): MenuItem[] => [
    {
      id: 'open',
      label: t('row.open'),
      onSelect: () => window.location.assign(`/customers/${encodeURIComponent(row.accountId)}`),
    },
    {
      id: 'copy-code',
      label: t('row.copy-code'),
      icon: 'clipboard',
      onSelect: () => void copyText(row.code, t('copied'), t('copy-failed')),
    },
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
      body={filtered ? t('empty.no-match-help') : undefined}
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {t('clear-filters')}
          </Button>
        ) : undefined
      }
    />
  );

  const pageSize = answer?.paging?.pageSize ?? query.pageSize;
  const start =
    answer?.paging === null || answer === null ? 0 : (answer.paging.page - 1) * pageSize;
  const sortOrder = (sort: SellerSort): readonly [string, string] =>
    sort === 'code'
      ? [t('sort.name.first'), t('sort.name.second')]
      : sort === 'orders' || sort === 'spent'
        ? [t('sort.figure.first'), t('sort.figure.second')]
        : [t('sort.date.first'), t('sort.date.second')];

  const failureMessage =
    failure === null
      ? null
      : typeof failure === 'object'
        ? t('error.throttled', { minutes: failure.throttled })
        : t(`error.${failure}`);

  return (
    <SuperList
      heading={{
        title: t('title'),
        subtitle: counts === null ? '' : t('subtitle', { count: counts.all }),
      }}
      views={{
        label: t('tabs'),
        activeId: query.view,
        onSelect: (id) => list.openView(id),
        items: SELLER_VIEWS.map((view) => ({
          id: view,
          label: `${t(`tab.${view}`)}${counts === null ? '' : ` (${number(counts[view])})`}`,
        })),
        manage: null,
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        value: list.draft,
        maxLength: CODE_SEARCH_MAX + 4,
        help: t('search.help'),
        onChange: list.setDraft,
        onSubmit: (value) => list.change({ q: value }),
      }}
      filter={{
        label: t('filter.button'),
        count: sellerFilterCount(query.filters),
        panel: (close) => (
          <SellerCustomersFilterPanel
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
            name="seller-customers-sort"
            sort={query.sort}
            direction={query.direction}
            fields={SELLER_SORTS.map((sort) => ({ id: sort, label: t(`sort.field.${sort}`) }))}
            defaultDirection={(sort) => defaultSellerDirection(sort as SellerSort)}
            orderLabels={(sort) => sortOrder(sort as SellerSort)}
            labels={{ by: t('sort.by'), order: t('sort.order') }}
            onChange={(sort, direction) => list.change({ sort: sort as SellerSort, direction })}
          />
        ),
      }}
      columns={{
        label: t('columns.button'),
        panel: (close) => (
          <ListColumnsPanel
            columns={columns}
            optional={SELLER_OPTIONAL_COLUMNS}
            defaults={DEFAULT_COLUMNS}
            fixed={[
              { id: 'code', label: t('col.code') },
              { id: 'first-name', label: t('col.first-name') },
              { id: 'orders', label: t('col.orders') },
              { id: 'spent', label: t('col.spent') },
              { id: 'last-order', label: t('col.last-order') },
              { id: 'badges', label: t('col.badges') },
            ]}
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
        order: sortOrder(query.sort)[
          query.direction === defaultSellerDirection(query.sort) ? 0 : 1
        ],
      })}
      chips={
        filtered || shortSearch
          ? {
              chips: chips.map((chip) => ({
                key: chip.key,
                label: chip.label,
                removeLabel: t('chip-remove', { filter: chip.label }),
                onRemove: () => list.change(chip.patch),
              })),
              clearAll: filtered ? { label: t('clear-all'), onClick: clearAll } : undefined,
              status: shortSearch
                ? t('search.too-short', { min: CODE_SEARCH_MIN })
                : answer === null || failure !== null
                  ? ''
                  : t('match', { count: total }),
            }
          : null
      }
      failure={
        failureMessage === null
          ? null
          : {
              message: failureMessage,
              ...(failure === 'unavailable' || typeof failure === 'object'
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
        <SuperTable
          caption={t('caption')}
          rows={answer?.items ?? []}
          rowId={(row) => row.accountId}
          rowName={(row) => row.code}
          columns={tableColumns}
          actions={{
            header: t('col.actions'),
            label: (name) => t('row.menu', { name }),
            items: rowItems,
          }}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
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
              pageSizes: SELLER_PAGE_SIZES,
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
    />
  );
}
