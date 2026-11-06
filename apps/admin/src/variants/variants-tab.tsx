'use client';

import {
  Badge,
  Button,
  CARD_TABLE,
  EmptyState,
  LoadError,
  SearchField,
  Select,
  SkeletonRows,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import {
  API_VARIANT_TYPES,
  API_VARIANTS,
  ISSUES,
  gtinText,
  localesOf,
  nameOf,
  type IssueCounts,
  type Issue,
  type VariantPage,
  type VariantRow,
  type VariantTypeSummary,
} from './types.ts';

const LIMIT = 25;
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

type Load = 'loading' | 'ready' | 'failed';

/**
 * The Variants tab (variants V6; plan section 9): every variant of the Market's live products,
 * newest first, searched by product name, product or variant code, GTIN or seller SKU, kept to
 * one variant type and to one ready-made issue. A row opens its product. The list and its export
 * use the same filter.
 */
export function VariantsTab() {
  const t = useTranslations('variants.list');
  const tl = useTranslations('load');
  const [types, setTypes] = useState<readonly VariantTypeSummary[]>([]);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [typeCode, setTypeCode] = useState('');
  const [issue, setIssue] = useState<Issue | null>(null);
  const [counts, setCounts] = useState<IssueCounts['counts'] | null>(null);
  const [rows, setRows] = useState<readonly VariantRow[]>([]);
  const [nextAfter, setNextAfter] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [more, setMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    void (async () => {
      const result = await callApi<{ items: VariantTypeSummary[] }>('GET', API_VARIANT_TYPES);
      if (result.ok) setTypes(result.body.items);
    })();
  }, []);

  // The search applies after a short pause in typing.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const filterParams = useCallback(() => {
    const params = new URLSearchParams();
    if (query !== '') params.set('q', query);
    if (typeCode !== '') params.set('typeCode', typeCode);
    if (issue !== null) params.set('issue', issue);
    return params;
  }, [query, typeCode, issue]);

  const fetchPage = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    const params = filterParams();
    params.set('limit', String(LIMIT));
    const countParams = new URLSearchParams(typeCode === '' ? {} : { typeCode });
    const [page, issueCounts] = await Promise.all([
      callApi<VariantPage>('GET', `${API_VARIANTS}?${params.toString()}`),
      callApi<IssueCounts>(
        'GET',
        `${API_VARIANTS}/issue-counts${countParams.size === 0 ? '' : `?${countParams.toString()}`}`,
      ),
    ]);
    if (ticket !== latest.current) return;
    if (!page.ok && page.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setCounts(issueCounts.ok ? issueCounts.body.counts : null);
    if (page.ok) {
      setRows(page.body.items);
      setNextAfter(page.body.nextAfter);
      setLoad('ready');
    } else {
      setLoad('failed');
    }
  }, [filterParams, typeCode]);

  useEffect(() => {
    void fetchPage();
  }, [fetchPage]);

  async function loadMore() {
    if (nextAfter === null || more) return;
    setMore(true);
    const params = filterParams();
    params.set('limit', String(LIMIT));
    params.set('after', nextAfter);
    const ticket = latest.current;
    const result = await callApi<VariantPage>('GET', `${API_VARIANTS}?${params.toString()}`);
    setMore(false);
    if (ticket !== latest.current) return;
    if (result.ok) {
      setRows([...rows, ...result.body.items]);
      setNextAfter(result.body.nextAfter);
    } else {
      toast.error(t('more-error'));
    }
  }

  async function exportFile(format: 'csv' | 'xlsx') {
    setExporting(true);
    const params = filterParams();
    params.set('format', format);
    const work = (async () => {
      let response: Response;
      try {
        response = await fetch(`/api/${API_VARIANTS}/export?${params.toString()}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
      } catch {
        throw new Error(t('export.unavailable'));
      }
      if (!response.ok) {
        const body = (await response.json().catch((): unknown => null)) as {
          code?: string;
          details?: { max?: number };
        } | null;
        throw new Error(
          body?.code === 'batch.too-large'
            ? t('export.too-large', { max: body.details?.max ?? 10000 })
            : t('export.unavailable'),
        );
      }
      // The bytes as sent: text() would drop the CSV's byte order mark, which Excel needs.
      const blob = new Blob([await response.arrayBuffer()], {
        type: format === 'xlsx' ? XLSX_TYPE : 'text/csv;charset=utf-8',
      });
      const link = document.createElement('a');
      const url = URL.createObjectURL(blob);
      link.href = url;
      link.download = `variants-${new Date().toISOString().slice(0, 10)}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    })();
    try {
      await toast.promise(
        work,
        {
          pending: t('export.pending'),
          success: t('export.done'),
          error: (error: unknown) =>
            error instanceof Error ? error.message : t('export.unavailable'),
        },
        { id: 'variants-export' },
      );
    } catch {
      // The toast says what went wrong.
    } finally {
      setExporting(false);
    }
  }

  const locales = localesOf(types);
  const locale = locales[0] ?? 'en';
  const filtered = query !== '' || typeCode !== '' || issue !== null;

  return (
    <section
      aria-label={t('label')}
      className="flex min-w-0 flex-col rounded-lg border border-line bg-surface"
    >
      <div
        role="search"
        aria-label={t('filters')}
        className="flex flex-col gap-3 border-b border-line p-4"
      >
        <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,14rem)_auto] md:items-end">
          <SearchField
            name="variant-search"
            label={t('search')}
            placeholder={t('search-placeholder')}
            value={search}
            autoComplete="off"
            maxLength={100}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            label={t('type')}
            value={typeCode}
            onChange={(event) => setTypeCode(event.target.value)}
            options={[
              { value: '', label: t('type-all') },
              ...types.map((type) => ({ value: type.code, label: nameOf(type, locale) })),
            ]}
          />
          <div className="flex gap-2">
            <Button variant="secondary" disabled={exporting} onClick={() => void exportFile('csv')}>
              {t('export.csv')}
            </Button>
            <Button
              variant="secondary"
              disabled={exporting}
              onClick={() => void exportFile('xlsx')}
            >
              {t('export.xlsx')}
            </Button>
          </div>
        </div>
        <div className="flex flex-wrap gap-2" role="group" aria-label={t('issues')}>
          {ISSUES.map((each) => {
            const on = issue === each;
            const count = counts?.[each];
            return (
              <button
                key={each}
                type="button"
                aria-pressed={on}
                onClick={() => setIssue(on ? null : each)}
                className={`inline-flex min-h-(--mp-size-control) items-center gap-2 rounded-full border px-4 text-sm font-medium ${
                  on
                    ? 'border-accent bg-accent text-on-accent'
                    : 'border-line-control bg-surface text-fg hover:bg-muted'
                }`}
              >
                {count === undefined
                  ? t(`issue.${each}`)
                  : t('issue-count', { issue: t(`issue.${each}`), count })}
              </button>
            );
          })}
        </div>
        <p className="text-sm text-fg-muted">{t('stock-note')}</p>
      </div>
      {load === 'loading' && rows.length === 0 ? (
        <div className="p-4">
          <SkeletonRows label={t('loading')} rows={6} />
        </div>
      ) : null}
      {load === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3 p-6"
          message={t('load-error')}
          retryLabel={tl('retry')}
          onRetry={() => void fetchPage()}
        />
      ) : null}
      {load === 'ready' && rows.length === 0 ? (
        <EmptyState
          size="compact"
          icon="columns"
          title={filtered ? t('empty-filtered') : t('empty')}
          action={
            filtered ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setSearch('');
                  setQuery('');
                  setTypeCode('');
                  setIssue(null);
                }}
              >
                {t('clear')}
              </Button>
            ) : undefined
          }
        />
      ) : null}
      {rows.length > 0 && load !== 'failed' ? (
        <div className="overflow-x-auto">
          <table className={CARD_TABLE.table}>
            <caption className="sr-only">{t('label')}</caption>
            <thead className={CARD_TABLE.head}>
              <tr>
                <th scope="col" className="px-4 py-2 text-start font-medium">
                  {t('col.variant')}
                </th>
                <th scope="col" className="px-4 py-2 text-start font-medium">
                  {t('col.code')}
                </th>
                <th scope="col" className="px-4 py-2 text-start font-medium">
                  {t('col.gtin')}
                </th>
                <th scope="col" className="px-4 py-2 text-start font-medium">
                  {t('col.sellers')}
                </th>
                <th scope="col" className="px-4 py-2 text-start font-medium">
                  {t('col.issues')}
                </th>
              </tr>
            </thead>
            <tbody className={CARD_TABLE.body}>
              {rows.map((row) => (
                <tr key={row.variantId} className={CARD_TABLE.row}>
                  <td className={CARD_TABLE.cell}>
                    <a
                      className="font-medium text-link underline wrap-anywhere"
                      href={`/catalog/products/${encodeURIComponent(row.productId)}`}
                    >
                      {row.productName ?? row.productCode}
                    </a>
                    <span className="block text-fg-muted wrap-anywhere">
                      {row.label ?? t('no-label')}
                    </span>
                    {row.status === 'paused' ? <Badge tone="neutral">{t('paused')}</Badge> : null}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.code')}>
                    <span className="font-mono">{row.variantCode}</span>
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.gtin')}>
                    {row.gtin === null ? (
                      <span className="text-fg-muted">—</span>
                    ) : (
                      <span className="font-mono">{gtinText(row.gtin)}</span>
                    )}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.sellers')}>
                    {row.sellers}
                  </td>
                  <td className={CARD_TABLE.labelled} data-label={t('col.issues')}>
                    {row.issues.length === 0 ? (
                      <span className="text-fg-muted">—</span>
                    ) : (
                      <span className="flex flex-wrap gap-1">
                        {row.issues.map((each) => (
                          <Badge
                            key={each}
                            tone={each === 'duplicate-gtin' ? 'critical' : 'attention'}
                          >
                            {t(`issue.${each}`)}
                          </Badge>
                        ))}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {load === 'ready' && rows.length > 0 ? (
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-fg-muted">
          <p>{t('shown', { count: rows.length })}</p>
          {nextAfter !== null ? (
            <Button
              variant="secondary"
              loading={more}
              disabled={more}
              onClick={() => void loadMore()}
            >
              {t('more')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
