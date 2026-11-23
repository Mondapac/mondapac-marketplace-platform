'use client';

import {
  Button,
  EmptyState,
  SuperList,
  browserStorage,
  listSkeletonRowCount,
  prefsKey,
  readIds,
  toast,
  useListLoading,
  useRowSelection,
  useSuperListQuery,
  writeIds,
  type MenuItem,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { resolveZone } from '../price/zone-time.ts';
import { numberFormat } from '../shared/intl.ts';
import { DEFAULT_COLUMNS, cleanColumns, type CustomerColumn } from './columns.ts';
import { CustomersExport, EXPORT_CODES_MAX } from './customers-export.tsx';
import {
  CustomersColumnsPanel,
  CustomersFilterPanel,
  CustomersSortPanel,
} from './customers-panels.tsx';
import { CustomersTable } from './customers-table.tsx';
import {
  DEFAULT_QUERY,
  MAX_PAGED_ROWS,
  PAGE_SIZE,
  defaultDirection,
  filterCount,
  listBody,
  searchIsValid,
  type Direction,
  type FilterKey,
  type ListPaging,
  type Query,
  type SortField,
} from './query.ts';
import { CUSTOMER_VIEWS, type CustomerView, type SellerCustomerPage } from './types.ts';

const OPEN_ENDED = Number.MAX_SAFE_INTEGER;
const LIST_PATH = 'customers/seller/customers/list';

type Failure =
  | { readonly kind: 'refused' }
  | { readonly kind: 'denied' }
  | { readonly kind: 'not-approved' }
  | { readonly kind: 'throttled'; readonly minutes: number }
  | { readonly kind: 'unavailable' };

/** The refusals that mean "this shop is not approved", which have their own notice. */
export const NOT_APPROVED_CODES: ReadonlySet<string> = new Set([
  'access.seller-not-approved',
  'seller.not-eligible',
]);

/** What a failed list read means for the page: only a 403 hides it, a 429 says when to retry. */
export function failureOf(failure: ApiFailure): Failure {
  // A shop that is not approved gets the notice; any other 403 hides the page.
  if (failure.status === 403) {
    return NOT_APPROVED_CODES.has(failure.code) ? { kind: 'not-approved' } : { kind: 'denied' };
  }
  if (failure.status === 429) {
    const seconds = failure.details?.retryAfterSeconds ?? 60;
    return { kind: 'throttled', minutes: Math.max(1, Math.ceil(seconds / 60)) };
  }
  return failure.code === 'validation.failed' ? { kind: 'refused' } : { kind: 'unavailable' };
}

const noActions = () => [];

const forView = (view: string): Query => ({ ...DEFAULT_QUERY, view: view as CustomerView });
const withView = (current: Query, view: string): Query => ({
  ...current,
  view: view as CustomerView,
});
const searchOf = (current: Query): string => current.q;
// Text that is not 2 to 8 code symbols asks for nothing: the query keeps the search it had.
const withSearch = (current: Query, text: string): Query =>
  text === ''
    ? { ...current, q: '' }
    : searchIsValid(text)
      ? { ...current, q: text.trim() }
      : current;

/**
 * The shop's Customers (a super list): the views All, Buyers, Followers and Referred with their
 * counts, a search by code, the filter, sort and column panels with removable chips, rows with an
 * Actions menu (Open, Copy code), a selection that feeds Export…, and the footer that follows the
 * Market's List paging setting. A customer is the shop's code and a first name: never contact
 * details. There are no bulk writes and no saved filters (the API has neither for sellers yet).
 */
export function CustomersList({
  paging = 'prev-next',
  accountId = '',
  marketId = '',
  csrfToken = '',
  canExport = false,
  canInvite = false,
}: {
  readonly paging?: ListPaging;
  readonly accountId?: string;
  readonly marketId?: string;
  readonly csrfToken?: string;
  readonly canExport?: boolean;
  readonly canInvite?: boolean;
}) {
  const t = useTranslations('customers');
  const tl = useTranslations('load');
  const locale = useLocale();
  const zone = resolveZone(useTimeZone());
  const router = useRouter();
  const { query, draft, setDraft, change, goToPage, openView, reset } = useSuperListQuery<Query>({
    defaultQuery: DEFAULT_QUERY,
    forView,
    withView,
    searchOf,
    withSearch,
  });
  const [answer, setAnswer] = useState<SellerCustomerPage | null>(null);
  const [counts, setCounts] = useState<SellerCustomerPage['counts'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [hinted, setHinted] = useState(false);
  const [columns, setColumns] = useState<readonly CustomerColumn[]>(DEFAULT_COLUMNS);
  const [currency, setCurrency] = useState<string | null>(null);
  const latest = useRef(0);
  const storageKey = prefsKey('seller', marketId, accountId, 'customers-columns');
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);

  useEffect(() => {
    setColumns(cleanColumns(readIds(browserStorage(), storageKey)));
  }, [storageKey]);

  const load = useCallback(
    async (asked: Query) => {
      const ticket = ++latest.current;
      setLoading(true);
      setFailure(null);
      const result = await callApi<SellerCustomerPage>(
        'POST',
        LIST_PATH,
        listBody(asked),
        csrfToken,
      );
      if (ticket !== latest.current) return;
      setLoading(false);
      if (!result.ok) {
        if (result.failure.status === 401) {
          window.location.assign('/session-ended');
          return;
        }
        setFailure(failureOf(result.failure));
        return;
      }
      setAnswer(result.body);
      setCounts(result.body.counts);
      const known = result.body.items.find((row) => row.currency !== null)?.currency;
      if (known !== undefined && known !== null) setCurrency(known);
    },
    [csrfToken],
  );

  const queryNow = useRef(query);
  queryNow.current = query;
  const queryKey = JSON.stringify(query);
  useEffect(() => {
    void load(queryNow.current);
  }, [load, queryKey]);

  // Another view, search or filter is another list: the selection does not follow it. Paging keeps it.
  const listKey = JSON.stringify([query.view, query.q, query.filters, query.sort, query.direction]);
  const rows = answer?.items;
  const pageCodes = useMemo(() => rows?.map((row) => row.code) ?? [], [rows]);
  const selection = useRowSelection(pageCodes, EXPORT_CODES_MAX, listKey);
  const status = useListLoading(loading, answer !== null);
  useEffect(() => {
    if (!status.stalled) return;
    latest.current += 1;
    setLoading(false);
    setFailure({ kind: 'unavailable' });
  }, [status.stalled]);

  useEffect(() => {
    if (!loading && focusList.current) {
      focusList.current = false;
      listTop.current?.focus();
    }
  }, [loading, answer]);

  const total = answer?.paging?.total ?? null;
  const page = answer?.paging?.page ?? query.page;
  const mode: ListPaging = total === null ? 'prev-next' : paging;
  const number = (value: number) => numberFormat(locale, {}).format(value);

  // A page past the end (rows were removed meanwhile) goes back to the last one with rows.
  useEffect(() => {
    if (answer === null || loading || failure !== null || answer.items.length > 0) return;
    if (page > 1) goToPage(Math.max(1, Math.min(page - 1, Math.ceil((total ?? 0) / PAGE_SIZE))));
  }, [answer, loading, failure, page, total, goToPage]);

  async function copy(code: string) {
    try {
      await navigator.clipboard.writeText(code);
      toast.success(t('row-actions.copied'));
    } catch {
      toast.error(t('row-actions.copy-failed'));
    }
  }
  const rowActions = (row: { readonly code: string }): readonly MenuItem[] => [
    {
      id: 'open',
      label: t('row-actions.open'),
      onSelect: () => router.push(`/customers/${encodeURIComponent(row.code)}`),
    },
    { id: 'copy', label: t('row-actions.copy'), onSelect: () => void copy(row.code) },
  ];

  const saveColumns = (next: readonly CustomerColumn[]) => {
    setColumns(next);
    writeIds(browserStorage(), storageKey, next);
  };
  const clearAll = () => reset({ q: '', filters: {} });

  const filterChip = (key: string, label: string, remove: readonly FilterKey[]) => ({
    key,
    label,
    onRemove: () => {
      const rest = { ...query.filters };
      for (const field of remove) delete rest[field];
      change({ filters: rest });
    },
  });
  const f = query.filters;
  const range = (from?: string, to?: string) =>
    from !== undefined && to !== undefined
      ? t('filter.chip-range', { from, to })
      : from !== undefined
        ? t('filter.chip-from', { value: from })
        : t('filter.chip-to', { value: to ?? '' });
  const chips = [
    ...(query.q === ''
      ? []
      : [
          {
            key: 'search',
            label: t('chip-search', { text: query.q }),
            onRemove: () => reset({ q: '' }),
          },
        ]),
    ...(f.follower === undefined
      ? []
      : [
          filterChip('follower', t('filter.chip-follower', { value: t(`filter.${f.follower}`) }), [
            'follower',
          ]),
        ]),
    ...(f.exclusive === undefined
      ? []
      : [
          filterChip(
            'exclusive',
            t('filter.chip-exclusive', { value: t(`filter.${f.exclusive}`) }),
            ['exclusive'],
          ),
        ]),
    ...(f.lastOrderFrom === undefined && f.lastOrderTo === undefined
      ? []
      : [
          filterChip(
            'lastOrder',
            t('filter.chip', {
              field: t('filter.name.lastOrder'),
              value: range(f.lastOrderFrom, f.lastOrderTo),
            }),
            ['lastOrderFrom', 'lastOrderTo'],
          ),
        ]),
    ...(f.ordersMin === undefined && f.ordersMax === undefined
      ? []
      : [
          filterChip(
            'orders',
            t('filter.chip', {
              field: t('filter.name.orders'),
              value: range(f.ordersMin, f.ordersMax),
            }),
            ['ordersMin', 'ordersMax'],
          ),
        ]),
    ...(f.spentMin === undefined && f.spentMax === undefined
      ? []
      : [
          filterChip(
            'spent',
            t('filter.chip', {
              field: t('filter.name.spent', { currency: currency ?? '' }),
              value: range(f.spentMin, f.spentMax),
            }),
            ['spentMin', 'spentMax'],
          ),
        ]),
  ].map((chip) => ({ ...chip, removeLabel: t('chip-remove', { filter: chip.label }) }));
  const filtered = chips.length > 0;

  const shopEmpty =
    answer !== null &&
    failure === null &&
    !filtered &&
    query.view === 'all' &&
    answer.items.length === 0 &&
    (counts === null || counts.all === 0);
  const empty = shopEmpty ? (
    <EmptyState
      icon="users"
      title={t('empty.title')}
      body={t('empty.body')}
      action={
        canInvite ? (
          <a className="font-medium text-link underline" href="/settings/invite-customers">
            {t('empty.invite')}
          </a>
        ) : undefined
      }
    />
  ) : (
    <EmptyState
      size="compact"
      icon="search"
      title={t('empty-filtered.title')}
      body={t('empty-filtered.body')}
      action={
        filtered ? (
          <Button variant="secondary" onClick={clearAll}>
            {t('clear-all')}
          </Button>
        ) : undefined
      }
    />
  );

  if (failure?.kind === 'not-approved') {
    return (
      <EmptyState
        size="page"
        icon="lock"
        title={t('not-approved.title')}
        body={t('not-approved.body')}
      />
    );
  }
  if (failure?.kind === 'denied') {
    return <EmptyState size="page" icon="lock" title={t('denied.title')} body={t('denied.body')} />;
  }

  const skeleton = status.skeleton && failure === null;
  const shown = answer?.items ?? [];
  const wholePageTicked =
    shown.length > 0 &&
    !selection.allMatching &&
    shown.every((row) => selection.selected.has(row.code));
  const moreThanPage = (total ?? 0) > shown.length;
  const start = (page - 1) * PAGE_SIZE;
  const sortKind =
    query.sort === 'code'
      ? 'text'
      : query.sort === 'orders' || query.sort === 'spent'
        ? 'amount'
        : 'date';
  const sortOrder = t(
    `sort.${sortKind}.${query.direction === defaultDirection(query.sort) ? 'first' : 'second'}`,
  );

  const failureText =
    failure === null
      ? null
      : failure.kind === 'refused'
        ? { message: t('error.refused') }
        : failure.kind === 'throttled'
          ? {
              message: t('error.throttled', { minutes: failure.minutes }),
              retry: { label: tl('retry'), onClick: () => void load(query) },
            }
          : {
              message: t('error.unavailable'),
              retry: { label: tl('retry'), onClick: () => void load(query) },
            };

  const table = (
    <div className="flex flex-col gap-4">
      {mode === 'pages' && (total ?? 0) > MAX_PAGED_ROWS ? (
        <p role="status" className="rounded-lg border border-line bg-muted px-4 py-2 text-sm">
          {t('too-many', { limit: number(MAX_PAGED_ROWS) })}
        </p>
      ) : null}
      {canExport && (selection.selected.size > 0 || selection.allMatching) ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-line bg-muted px-4 py-2 text-sm">
          <p role="status" aria-live="polite" className="font-medium text-fg">
            {selection.allMatching
              ? t('selection.all', { count: number(total ?? 0) })
              : t('selection.selected', { count: selection.selected.size })}
          </p>
          {!selection.allMatching && wholePageTicked && moreThanPage && failure === null ? (
            <Button variant="link" size="sm" onClick={selection.selectAllMatching}>
              {t('selection.select-all', { count: number(total ?? 0) })}
            </Button>
          ) : null}
          <Button variant="link" size="sm" onClick={selection.clear}>
            {t('selection.clear')}
          </Button>
        </div>
      ) : null}
      <div ref={listTop} tabIndex={-1} className="outline-none">
        <CustomersTable
          rows={shown}
          columns={columns}
          selection={canExport ? selection : null}
          empty={empty}
          skeletonRows={skeleton ? listSkeletonRowCount(PAGE_SIZE) : undefined}
          actions={failure === null ? rowActions : noActions}
        />
      </div>
    </div>
  );

  const hinting = hinted && draft.trim() !== '' && !searchIsValid(draft);
  return (
    <SuperList
      heading={{
        actions: canExport ? (
          <CustomersExport
            query={query}
            selectedCodes={[...selection.selected]}
            allMatching={selection.allMatching}
            total={total}
            csrfToken={csrfToken}
            timeZone={zone}
            disabled={failure !== null}
          />
        ) : undefined,
      }}
      views={{
        label: t('views.label'),
        activeId: query.view,
        onSelect: (id) => openView(id),
        items: CUSTOMER_VIEWS.map((id) => ({
          id,
          label: `${t(`views.${id}`)}${counts === null ? '' : ` (${number(counts[id])})`}`,
        })),
        manage: null,
      }}
      search={{
        label: t('search.label'),
        placeholder: t('search.placeholder'),
        help: t('search.help'),
        value: draft,
        maxLength: 20,
        onChange: (value) => {
          setHinted(false);
          setDraft(value);
        },
        onBlur: () => setHinted(true),
        onSubmit: (value) => {
          setHinted(true);
          if (value === '' || searchIsValid(value)) change({ q: value.trim() });
        },
        extra: hinting ? (
          <p role="status" className="w-full text-sm text-fg-muted">
            {t('search.invalid')}
          </p>
        ) : undefined,
      }}
      filter={{
        label: t('filter.button'),
        count: filterCount(query.filters),
        panel: (close) => (
          <CustomersFilterPanel
            filters={query.filters}
            currency={currency}
            onApply={(filters) => change({ filters })}
            close={close}
          />
        ),
      }}
      sort={{
        label: t('sort.button'),
        panel: () => (
          <CustomersSortPanel
            sort={query.sort}
            direction={query.direction}
            onChange={(sort: SortField, direction: Direction) => change({ sort, direction })}
          />
        ),
      }}
      columns={{
        label: t('columns-button'),
        panel: (close) => (
          <CustomersColumnsPanel columns={columns} onSave={saveColumns} close={close} />
        ),
      }}
      sortedLine={t('sorted', { field: t(`sort.field.${query.sort}`), order: sortOrder })}
      chips={
        filtered
          ? {
              chips,
              clearAll: { label: t('clear-all'), onClick: clearAll },
              status: total === null || failure !== null ? '' : t('match', { count: total }),
            }
          : null
      }
      failure={failureText}
      firstLoadError={answer === null && failure !== null}
      loading={loading}
      status={status}
      loadingLabel={t('loading')}
      slowLabel={tl('slow')}
      ready={answer !== null}
      table={table}
      pagination={
        answer !== null && answer.items.length > 0 && failure === null && total !== null
          ? {
              mode,
              page,
              pageSize: PAGE_SIZE,
              pageSizes: [PAGE_SIZE],
              total:
                mode === 'pages'
                  ? Math.min(total, MAX_PAGED_ROWS)
                  : page * PAGE_SIZE < total
                    ? page * PAGE_SIZE + 1
                    : (page - 1) * PAGE_SIZE + answer.items.length,
              maxRows: mode === 'pages' ? MAX_PAGED_ROWS : OPEN_ENDED,
              range:
                mode === 'pages'
                  ? t('range', {
                      from: number(start + 1),
                      to: number(start + answer.items.length),
                      total: number(total),
                    })
                  : '',
              labels: {
                rowsPerPage: t('paging.rows-per-page'),
                previous: t('paging.previous'),
                next: t('paging.next'),
                pages: t('paging.pages'),
                page: (n) => t('paging.page', { page: n }),
                narrowTitle: t('paging.narrow'),
                narrowBody: t('paging.narrow-help'),
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
