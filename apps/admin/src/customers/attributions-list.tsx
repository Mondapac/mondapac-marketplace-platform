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
  useRowSelection,
  useBaseTabCounts,
  useSuperListQuery,
  writeIds,
  type MenuItem,
  type SuperColumn,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { AttributionsBulk } from './attributions-bulk.tsx';
import {
  AttributionDecideDialogs,
  type DecideRequest,
  type Decision,
} from './attributions-decide.tsx';
import { AttributionsFilterPanel } from './attributions-filter-panel.tsx';
import {
  ATTRIBUTIONS_LIST_KEY,
  ATTRIBUTIONS_MANAGE_PERMISSION,
  ATTRIBUTIONS_SHARE_PERMISSION,
  ATTRIBUTION_FILTER_KEYS,
  ATTRIBUTION_OPTIONAL_COLUMNS,
  ATTRIBUTION_PAGE_SIZES,
  ATTRIBUTION_VIEWS,
  DEFAULT_ATTRIBUTION_QUERY,
  ATTRIBUTION_DEFAULT_COLUMNS,
  SEARCH_MAX,
  SEARCH_MIN,
  SELECT_MAX,
  attributionFilterCount,
  attributionPayloadOf,
  attributionQueryOfPayload,
  attributionSearchOf,
  attributionSelectorOf,
  attributionTitleOf,
  cleanAttributionColumns,
  type AttributionFilterKey,
  type AttributionFilters,
  type AttributionOptionalColumn,
  type AttributionQuery,
  type AttributionRow,
  type AttributionSavedAnswer,
  type AttributionsPage,
} from './attributions-types.ts';
import { SELLERS_VIEW_PERMISSION } from './seller-names.tsx';
import { CustomersSavedDialogs } from './customers-saved.tsx';
import { timeOf } from './format.ts';
import { minutesOf } from './security-shared.tsx';
import { shortId, useSellerNames } from './seller-names.tsx';

type Failure = 'denied' | 'invalid' | 'unavailable' | { readonly throttled: number };

/**
 * The suspicious attributions list (customers management phase 4a), a super list: customers who
 * joined a seller through its invite link. The four views with counts (Suspicious first) and the
 * saved filters, search by the start of the sign-in address, the filter, sort and column panels
 * with chips, row selection with "select all matching", the Bulk action menu (Reject…, Restore…,
 * Export…), the row Actions menu and the footer of the Market's List paging setting. A 403 hides
 * the section. Admin only: the sign-in address is shown here and nowhere in a seller panel.
 */
export function AttributionsList({
  accountId,
  marketId,
  zone,
  paging,
  permissionKeys,
  csrfToken,
}: {
  readonly accountId: string;
  readonly marketId: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('customers.attributions');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [answer, setAnswer] = useState<AttributionsPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [saved, setSaved] = useState<AttributionSavedAnswer | null>(null);
  const [dialog, setDialog] = useState<'save' | 'manage' | null>(null);
  const [columns, setColumns] = useState<readonly AttributionOptionalColumn[]>(
    ATTRIBUTION_DEFAULT_COLUMNS,
  );
  const [decide, setDecide] = useState<DecideRequest | null>(null);
  const latest = useRef(0);
  const sellers = useSellerNames();
  const storageKey = prefsKey('admin', marketId, accountId, 'seller-attributions-columns');

  const list = useSuperListQuery<AttributionQuery>({
    defaultQuery: DEFAULT_ATTRIBUTION_QUERY,
    forView: (view) => ({ ...DEFAULT_ATTRIBUTION_QUERY, view: view as AttributionQuery['view'] }),
    withView: (current, view) => ({ ...current, view: view as AttributionQuery['view'] }),
    searchOf: (current) => current.q,
    withSearch: (current, q) => ({ ...current, q }),
  });
  const { query } = list;
  const shortSearch = list.draft.trim().length > 0 && list.draft.trim().length < SEARCH_MIN;

  useEffect(() => {
    setColumns(cleanAttributionColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const loadSaved = useCallback(async (): Promise<AttributionSavedAnswer | null> => {
    const result = await callApi<AttributionSavedAnswer>(
      'GET',
      `customers/admin/saved-filters?listKey=${ATTRIBUTIONS_LIST_KEY}`,
    );
    if (!result.ok) return null;
    setSaved(result.body);
    return result.body;
  }, []);
  useEffect(() => {
    void loadSaved();
  }, [loadSaved]);

  const canReadSellers = permissionKeys.includes(SELLERS_VIEW_PERMISSION);
  const { resolve } = sellers;
  const load = useCallback(
    async (next: AttributionQuery) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<AttributionsPage>(
        'POST',
        'customers/admin/seller-attributions/list',
        {
          ...attributionSelectorOf(next),
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
            : result.failure.status === 429
              ? { throttled: minutesOf(result.failure, 60) }
              : result.failure.code === 'validation.failed'
                ? 'invalid'
                : 'unavailable',
        );
        return;
      }
      setAnswer(result.body);
      if (canReadSellers) {
        void resolve(
          result.body.items.map((row) => row.sellerId),
          csrfToken,
        );
      }
    },
    [csrfToken, resolve, canReadSellers],
  );
  useEffect(() => {
    void load(query);
  }, [load, query]);
  // A saved filter is a tab of its own: it does not narrow the counts of the built-in tabs.
  const counts = useBaseTabCounts<AttributionsPage['counts']>({
    savedId: list.savedId,
    live: answer?.counts ?? null,
    load: async () => {
      const result = await callApi<AttributionsPage>(
        'POST',
        'customers/admin/seller-attributions/list',
        {
          ...attributionSelectorOf(DEFAULT_ATTRIBUTION_QUERY),
          direction: DEFAULT_ATTRIBUTION_QUERY.direction,
          page: 1,
          pageSize: 1,
        },
        csrfToken,
      );
      return result.ok ? result.body.counts : null;
    },
  });
  // The store a saved filter or the URL names is read once, for its chip.
  const filterSellerId = query.filters.sellerId;
  useEffect(() => {
    if (filterSellerId !== undefined && canReadSellers) void resolve([filterSellerId], csrfToken);
  }, [filterSellerId, resolve, csrfToken, canReadSellers]);

  const selectionKey = JSON.stringify([query.view, query.q, query.filters, query.direction]);
  const pageIds = useMemo(() => answer?.items.map((row) => row.accountId) ?? [], [answer]);
  const selection = useRowSelection(pageIds, SELECT_MAX, selectionKey);
  const status = useListLoading(loading, answer !== null);
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure('unavailable');
  }, [status.stalled]);
  const firstLoadError = answer === null && failure !== null && failure !== 'denied';
  const skeleton = status.skeleton && failure === null;

  // A 403 removes the section (the page then says the role has no access).
  if (failure === 'denied') return <p className="text-fg-muted">{t('no-access')}</p>;

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const total = answer?.paging?.total ?? 0;
  const filtered =
    attributionSearchOf(query.q) !== undefined || attributionFilterCount(query.filters) > 0;
  const canManage = permissionKeys.includes(ATTRIBUTIONS_MANAGE_PERMISSION);
  const sellerLabel = (sellerId: string) =>
    sellers.names.get(sellerId) ?? t('seller-unknown', { id: shortId(sellerId) });

  const chipValue = (key: AttributionFilterKey, value: string): string => {
    if (key === 'sellerId') return sellerLabel(value);
    if (key === 'status') return t(`status.${value}`);
    if (key === 'rejectReason') return t(`reason.${value}`);
    if (key === 'flag') return t(`flag.${value}`);
    return value;
  };
  const withoutFilter = (key: AttributionFilterKey): AttributionFilters =>
    Object.fromEntries(Object.entries(query.filters).filter(([name]) => name !== key));
  const chips = ATTRIBUTION_FILTER_KEYS.flatMap((key) => {
    const value = query.filters[key];
    if (value === undefined) return [];
    const label = t('chip', { field: t(`filter.chip.${key}`), value: chipValue(key, value) });
    return [{ key, label, patch: { filters: withoutFilter(key) } }];
  });
  const clearAll = () => list.reset({ q: '', filters: {} });
  const summary = [
    t(`tab.${query.view}`),
    ...(attributionSearchOf(query.q) === undefined
      ? []
      : [t('saved-summary-search', { q: attributionSearchOf(query.q) ?? '' })]),
    ...chips.map((chip) => chip.label),
  ].join(' · ');

  const savedItems = saved?.items ?? [];
  const canShare = saved?.canShare ?? permissionKeys.includes(ATTRIBUTIONS_SHARE_PERMISSION);
  const limits = saved?.limits ?? { perOwner: 50, shared: 20 };

  const statusBadge = (row: AttributionRow) => (
    <Badge tone={row.status === 'active' ? 'success' : 'critical'}>
      {t(`status.${row.status}`)}
    </Badge>
  );
  const optionalColumn = (id: AttributionOptionalColumn): SuperColumn<AttributionRow> => {
    switch (id) {
      case 'reason':
        return {
          id,
          header: t('col.reason'),
          cell: (row) =>
            row.rejectReason === null ? (
              <span className="text-fg-muted">—</span>
            ) : (
              t(`reason.${row.rejectReason}`)
            ),
        };
      case 'flags':
        return {
          id,
          header: t('col.flags'),
          cell: (row) =>
            row.flags.length === 0 ? (
              <span className="text-fg-muted">—</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {row.flags.map((flag) => (
                  <Badge key={flag} tone="attention">
                    {t(`flag.${flag}`)}
                  </Badge>
                ))}
              </span>
            ),
        };
      case 'decided':
        return {
          id,
          header: t('col.decided'),
          cell: (row) =>
            row.decidedAt === null ? (
              <span className="text-fg-muted">—</span>
            ) : (
              timeOf(row.decidedAt, locale, zone)
            ),
        };
    }
  };

  const tableColumns: SuperColumn<AttributionRow>[] = [
    {
      id: 'customer',
      header: t('col.customer'),
      primary: true,
      headClassName: 'min-w-56',
      cell: (row) => {
        const named = attributionTitleOf(row) !== row.email;
        return (
          <div className="flex min-w-0 flex-col">
            <a
              href={`/customers/${encodeURIComponent(row.accountId)}`}
              className="font-medium text-fg wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-focus"
            >
              {attributionTitleOf(row)}
            </a>
            {named ? <span className="text-fg-muted wrap-anywhere">{row.email}</span> : null}
          </div>
        );
      },
    },
    {
      id: 'seller',
      header: t('col.seller'),
      cell: (row) => (
        <a
          href={`/sellers/${encodeURIComponent(row.sellerId)}`}
          className="text-link underline wrap-anywhere focus-visible:outline-2 focus-visible:outline-focus"
        >
          {sellerLabel(row.sellerId)}
        </a>
      ),
    },
    {
      id: 'attributed',
      header: t('col.attributed'),
      cell: (row) => timeOf(row.attributedAt, locale, zone),
    },
    { id: 'status', header: t('col.status'), corner: true, cell: statusBadge },
    ...columns.map(optionalColumn),
  ];

  const rowItems = (row: AttributionRow): MenuItem[] => [
    {
      id: 'open-customer',
      label: t('row.open-customer'),
      onSelect: () => window.location.assign(`/customers/${encodeURIComponent(row.accountId)}`),
    },
    {
      id: 'open-seller',
      label: t('row.open-seller'),
      onSelect: () => window.location.assign(`/sellers/${encodeURIComponent(row.sellerId)}`),
    },
    ...(canManage
      ? [
          {
            id: 'reject',
            label: t('row.reject'),
            tone: 'critical' as const,
            icon: 'ban' as const,
            disabled: row.status === 'rejected',
            ...(row.status === 'rejected' ? { reason: t('row.already-rejected') } : {}),
            onSelect: () =>
              setDecide({ decision: 'reject', target: { kind: 'ids', ids: [row.accountId] } }),
          },
          {
            id: 'restore',
            label: t('row.restore'),
            icon: 'check' as const,
            disabled: row.status === 'active' || row.rejectReason === 'seller-team',
            ...(row.rejectReason === 'seller-team'
              ? { reason: t('row.not-restorable') }
              : row.status === 'active'
                ? { reason: t('row.already-active') }
                : {}),
            onSelect: () =>
              setDecide({ decision: 'restore', target: { kind: 'ids', ids: [row.accountId] } }),
          },
        ]
      : []),
  ];

  const empty = (
    <EmptyState
      size="compact"
      icon={filtered ? 'search' : 'shield-check'}
      title={filtered ? t('empty.no-match') : t(`empty.view.${query.view}`)}
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
  const failureMessage =
    failure === null
      ? null
      : typeof failure === 'object'
        ? t('error.throttled', { minutes: failure.throttled })
        : t(`error.${failure}`);

  const labelOf = (id: string) => {
    const row = answer?.items.find((item) => item.accountId === id);
    return row === undefined ? null : attributionTitleOf(row);
  };

  const requestDecision = (decision: Decision) =>
    setDecide({
      decision,
      target: selection.allMatching
        ? { kind: 'matching', total }
        : { kind: 'ids', ids: [...selection.selected] },
    });

  return (
    <SuperList
      heading={{
        subtitle: counts === null ? '' : t('subtitle', { count: counts.all }),
        actions: (
          <AttributionsBulk
            selection={{
              ids: [...selection.selected],
              allMatching: selection.allMatching,
              total: failure === null ? total : 0,
            }}
            query={query}
            permissionKeys={permissionKeys}
            csrfToken={csrfToken}
            onDecide={requestDecision}
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
          if (filter !== undefined) {
            list.openSaved(id, attributionQueryOfPayload(filter.payload, query.pageSize));
          } else list.openView(id);
        },
        items: [
          ...ATTRIBUTION_VIEWS.map((view) => ({
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
            : { label: t('saved-manage-link'), onClick: () => setDialog('manage') },
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        value: list.draft,
        maxLength: SEARCH_MAX,
        help: t('search.help'),
        onChange: list.setDraft,
        onSubmit: (value) => list.change({ q: value }),
      }}
      filter={{
        label: t('filter.button'),
        count: attributionFilterCount(query.filters),
        panel: (close) => (
          <AttributionsFilterPanel
            filters={query.filters}
            sellerName={
              query.filters.sellerId === undefined
                ? null
                : (sellers.names.get(query.filters.sellerId) ?? null)
            }
            csrfToken={csrfToken}
            canPickSeller={canReadSellers}
            sellerLabel={
              query.filters.sellerId === undefined ? null : sellerLabel(query.filters.sellerId)
            }
            onSellerChosen={sellers.remember}
            onApply={(filters) => list.change({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: t('sort.button'),
        panel: () => (
          <ListSortPanel
            name="attributions-sort"
            sort="attributed"
            direction={query.direction}
            fields={[{ id: 'attributed', label: t('sort.field.attributed') }]}
            defaultDirection={() => 'desc'}
            orderLabels={() => [t('sort.date.first'), t('sort.date.second')]}
            labels={{ by: t('sort.by'), order: t('sort.order') }}
            onChange={(_sort, direction) => list.change({ direction })}
          />
        ),
      }}
      columns={{
        label: t('columns.button'),
        panel: (close) => (
          <ListColumnsPanel
            columns={columns}
            optional={ATTRIBUTION_OPTIONAL_COLUMNS}
            defaults={ATTRIBUTION_DEFAULT_COLUMNS}
            fixed={[
              { id: 'customer', label: t('col.customer') },
              { id: 'seller', label: t('col.seller') },
              { id: 'attributed', label: t('col.attributed') },
              { id: 'status', label: t('col.status') },
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
              const clean = cleanAttributionColumns(next);
              setColumns(clean);
              writeIds(browserStorage(), storageKey, clean);
            }}
            close={close}
          />
        ),
      }}
      sortedLine={t('sorted', {
        field: t('sort.field.attributed'),
        order: query.direction === 'desc' ? t('sort.date.first') : t('sort.date.second'),
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
              save:
                saved === null || list.savedId !== null || !filtered
                  ? undefined
                  : { label: t('saved-save-link'), onClick: () => setDialog('save') },
              status: shortSearch
                ? t('search.too-short', { min: SEARCH_MIN })
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
          rowName={attributionTitleOf}
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
          skeletonRows={skeleton ? listSkeletonRowCount(query.pageSize) : undefined}
          minWidthClass="lg:min-w-250"
        />
      }
      pagination={
        answer === null || answer.paging === null || total === 0
          ? null
          : {
              mode: paging,
              page: answer.paging.page,
              pageSize,
              pageSizes: ATTRIBUTION_PAGE_SIZES,
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
            listKey={ATTRIBUTIONS_LIST_KEY}
            payload={attributionPayloadOf(query)}
            sharedPayload={attributionPayloadOf({ ...query, q: '' })}
            sharedHelp={t('saved-shared-help')}
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
          <AttributionDecideDialogs
            request={decide}
            query={query}
            csrfToken={csrfToken}
            labelOf={labelOf}
            onClose={() => setDecide(null)}
            onDone={() => {
              selection.clear();
              void load(query);
            }}
          />
        </>
      }
    />
  );
}
