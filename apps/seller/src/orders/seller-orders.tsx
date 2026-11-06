'use client';

import {
  Banner,
  Button,
  EmptyState,
  Pagination,
  PrevNext,
  Select,
  Tabs,
  TextField,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { downloadOrders } from './export-file.ts';
import { OrdersTable } from './orders-table.tsx';
import {
  MAX_PAGED_ROWS,
  NO_DAYS,
  PAGE_SIZE,
  SORTS,
  pageCountOf,
  exportQueryOf,
  queryOf,
  rangeIsBackwards,
  type Days,
  type ListPaging,
  type SortId,
} from './orders-query.ts';
import { FULFILMENT_FILTERS, type FulfilmentFilter, type SellerOrderPage } from './types.ts';

/**
 * The seller's paid orders: a fulfilment tab, a payment-day range, a sort and either page numbers
 * with the total or "Show more" by cursor, as the Market's List paging setting says. The tab is the
 * API's `status` parameter, so it lists every order in that state, not only the ones loaded so far.
 * "Show more" keeps to newest first and works for any number of orders.
 */
export function SellerOrders({
  initial,
  paging = 'prev-next',
}: {
  readonly initial: SellerOrderPage;
  readonly paging?: ListPaging;
}) {
  const t = useTranslations('orders');
  const locale = useLocale();
  // What the rows on screen answer. Nothing here changes until an answer arrives, so a failed
  // request leaves the old rows under the old tab, days, sort and range line.
  const [orders, setOrders] = useState(initial.sellerOrders);
  const [next, setNext] = useState(initial.nextCursor);
  const [total, setTotal] = useState<number | null>(initial.total ?? null);
  const [filter, setFilter] = useState<FulfilmentFilter>('all');
  const [days, setDays] = useState<Days>(NO_DAYS);
  const [sort, setSort] = useState<SortId>('newest');
  const [page, setPage] = useState(1);
  // Previous and next: the cursor that opened each page seen so far (the first page has none).
  const [cursors, setCursors] = useState<readonly (string | null)[]>([null]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportNote, setExportNote] = useState<{
    readonly tone: 'info' | 'critical';
    readonly text: string;
  } | null>(null);
  // Only the newest question may fill the list: a slow answer for old filters is dropped.
  const latest = useRef(0);
  // After a page change the focus moves to the top of the list, so a keyboard or screen reader
  // user starts on the new rows and not on the pager they used.
  const listTop = useRef<HTMLDivElement>(null);
  const focusList = useRef(false);
  const backwards = rangeIsBackwards(days);
  const number = (n: number) => n.toLocaleString(locale);

  useEffect(() => {
    if (!loading && focusList.current) {
      focusList.current = false;
      listTop.current?.focus();
    }
  }, [loading, orders]);

  /** Asks for what the controls would say; the screen takes it over only when the answer is in. */
  async function ask(want: {
    filter?: FulfilmentFilter;
    days?: Days;
    sort?: SortId;
    page?: number;
    cursors?: readonly (string | null)[];
    focus?: boolean;
  }) {
    setExportNote(null);
    const nextFilter = want.filter ?? filter;
    const nextDays = want.days ?? days;
    const nextSort = want.sort ?? sort;
    const nextPage = want.page ?? 1;
    const nextCursors = want.cursors ?? [null];
    const ticket = ++latest.current;
    setFailed(false);
    if (rangeIsBackwards(nextDays)) {
      // Nothing matches; an answer still on its way for the days as they were must not fill it.
      setDays(nextDays);
      setOrders([]);
      setNext(null);
      setTotal(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const cursor = nextCursors[nextCursors.length - 1] ?? null;
    const result = await callApi<SellerOrderPage>(
      'GET',
      queryOf(
        nextFilter,
        nextDays,
        paging === 'pages' ? { paging, page: nextPage, sort: nextSort } : { paging, cursor },
      ),
    );
    if (ticket !== latest.current) return;
    if (!result.ok) {
      setLoading(false);
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setFailed(true);
      return;
    }
    focusList.current = want.focus === true;
    setFilter(nextFilter);
    setDays(nextDays);
    setSort(nextSort);
    setPage(nextPage);
    setCursors(nextCursors);
    setOrders(result.body.sellerOrders);
    setNext(result.body.nextCursor);
    setTotal(result.body.total ?? null);
    setLoading(false);
  }

  const filtered = days.from !== '' || days.to !== '';
  // The file holds every order the tab and days match, not only the page on screen.
  async function exportFile() {
    setExporting(true);
    setExportNote(null);
    const outcome = await downloadOrders(
      'ordering/seller/orders/export',
      exportQueryOf(filter, days),
    );
    setExporting(false);
    if (outcome.ok) {
      setExportNote({ tone: 'info', text: t('export.done') });
    } else if (outcome.reason === 'session') {
      window.location.assign('/session-ended');
    } else if (outcome.reason === 'too-large') {
      setExportNote({
        tone: 'critical',
        text:
          outcome.matching === undefined || outcome.max === undefined
            ? t('export.too-large-plain')
            : t('export.too-large', {
                matching: number(outcome.matching),
                max: number(outcome.max),
              }),
      });
    } else {
      setExportNote({ tone: 'critical', text: t(`export.${outcome.reason}`) });
    }
  }
  const everyState = filter === 'all' && !filtered;
  const pageCount = total === null ? 1 : pageCountOf(total);
  const first = total === null ? 0 : (page - 1) * PAGE_SIZE + 1;
  const cut = total !== null && total > MAX_PAGED_ROWS;
  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      {orders.length === 0 && everyState && !loading && !failed ? (
        <EmptyState icon="clipboard" title={t('empty-state.title')} body={t('empty-state.body')} />
      ) : (
        <>
          <Tabs
            label={t('filter.label')}
            activeId={filter}
            onSelect={(id) => {
              if (id !== filter && !loading) void ask({ filter: id as FulfilmentFilter });
            }}
            items={FULFILMENT_FILTERS.map((id) => ({
              id,
              label: t(id === 'all' || id === 'to-ship' ? `filter.${id}` : `status.${id}`),
            }))}
          />
          <div
            role="group"
            aria-label={t('filters.group')}
            className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4"
          >
            <TextField
              type="date"
              label={t('filters.from')}
              value={days.from}
              onChange={(event) => void ask({ days: { ...days, from: event.target.value } })}
            />
            <TextField
              type="date"
              label={t('filters.to')}
              value={days.to}
              error={backwards ? t('filters.backwards') : undefined}
              onChange={(event) => void ask({ days: { ...days, to: event.target.value } })}
            />
            {paging === 'pages' ? (
              <Select
                label={t('sort.label')}
                value={sort}
                options={SORTS.map((id) => ({ value: id, label: t(`sort.${id}`) }))}
                onChange={(event) => void ask({ sort: event.target.value as SortId })}
              />
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {filtered ? (
              <Button variant="secondary" onClick={() => void ask({ days: NO_DAYS })}>
                {t('filters.clear')}
              </Button>
            ) : null}
            <Button
              variant="secondary"
              disabled={exporting || loading || failed || backwards || orders.length === 0}
              onClick={() => void exportFile()}
            >
              {exporting ? t('export.busy') : t('export.button')}
            </Button>
          </div>
          {exportNote !== null ? (
            <div role="status">
              <Banner tone={exportNote.tone}>{exportNote.text}</Banner>
            </div>
          ) : null}
          {total !== null && orders.length > 0 ? (
            <p className="text-sm text-fg-muted" aria-live="polite">
              {t('range', {
                from: number(first),
                to: number(first + orders.length - 1),
                total: number(total),
              })}
            </p>
          ) : null}
          {failed ? <Banner tone="critical">{t('error.unavailable')}</Banner> : null}
          {orders.length === 0 && !loading && !failed ? (
            <EmptyState
              icon="clipboard"
              title={t('filter.empty.title')}
              body={t('filter.empty.body')}
            />
          ) : orders.length > 0 ? (
            <div ref={listTop} tabIndex={-1} className="outline-none">
              <OrdersTable orders={orders} />
            </div>
          ) : null}
        </>
      )}
      {cut ? <Banner tone="info">{t('too-many', { limit: number(MAX_PAGED_ROWS) })}</Banner> : null}
      {paging === 'pages' ? (
        <Pagination
          page={page}
          pageCount={pageCount}
          onPage={(n) => void ask({ page: n, focus: true })}
          disabled={loading}
          labels={{
            nav: t('paging.nav'),
            previous: t('paging.previous'),
            next: t('paging.next'),
            page: (n) => t('paging.page', { n }),
          }}
        />
      ) : (
        <PrevNext
          hasPrevious={cursors.length > 1}
          hasNext={next !== null}
          disabled={loading}
          onPrevious={() => void ask({ cursors: cursors.slice(0, -1), focus: true })}
          onNext={() => next !== null && void ask({ cursors: [...cursors, next], focus: true })}
          labels={{
            nav: t('paging.nav'),
            previous: t('paging.previous'),
            next: t('paging.next'),
          }}
        />
      )}
    </div>
  );
}
