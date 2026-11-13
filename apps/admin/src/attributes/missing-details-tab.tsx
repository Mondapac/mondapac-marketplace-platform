'use client';

import {
  Badge,
  Banner,
  Button,
  CheckboxRow,
  EmptyState,
  LoadError,
  SearchField,
  Select,
  SkeletonRows,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { callApi } from '../api/client.ts';
import { EmailSellersDialog, emailable } from './email-sellers-dialog.tsx';
import { API_MISSING_DETAILS, PAGE_SIZE, type MissingDetailsItem } from './types.ts';
import type { MissingDetailsPage } from './types.ts';

type Load =
  | { readonly state: 'loading' }
  | {
      readonly state: 'ready';
      readonly items: readonly MissingDetailsItem[];
      readonly nextAfterId: string | null;
      readonly scanned: number;
      readonly unreadable: readonly string[];
    }
  | { readonly state: 'failed' };

/** One CSV cell: quoted, and a leading formula character is neutralised. */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** The selected rows as CSV text (product code, name, seller, feature set, missing codes). */
export function csvOf(rows: readonly MissingDetailsItem[]): string {
  const head = ['Product code', 'Name', 'Seller id', 'Feature set', 'Missing'];
  const lines = rows.map((row) =>
    [row.productCode, row.name ?? '', row.sellerId ?? '', row.featureSetCode, row.missing.join(' ')]
      .map(csvCell)
      .join(','),
  );
  return [head.map(csvCell).join(','), ...lines].join('\r\n');
}

/**
 * The Missing details tab (attributes package A4, decision ت۷): published products whose values
 * leave a required attribute of their feature set empty. They stay on sale; the seller is refused
 * at the next submit until it is filled. The API reads at most 2000 products a call, so "Load more"
 * follows `nextAfterId`. The search box filters the rows already loaded.
 */
export function MissingDetailsTab({
  canEdit = false,
  csrfToken = '',
}: {
  /** `catalog.attribute.edit`: shows "Email sellers". */
  readonly canEdit?: boolean;
  readonly csrfToken?: string;
}) {
  const t = useTranslations('attributes.missing-details');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [more, setMore] = useState(false);
  const [search, setSearch] = useState('');
  const [featureSet, setFeatureSet] = useState('');
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [emailing, setEmailing] = useState(false);
  const [emailed, setEmailed] = useState<number | null>(null);

  const fetchPage = useCallback(async (afterId: string | null, append: boolean) => {
    if (append) setMore(true);
    else setLoad({ state: 'loading' });
    const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
    if (afterId !== null) query.set('afterId', afterId);
    const answer = await callApi<MissingDetailsPage>(
      'GET',
      `${API_MISSING_DETAILS}?${query.toString()}`,
    );
    setMore(false);
    if (!answer.ok) {
      if (answer.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      // A failed "Load more" keeps the rows already shown.
      if (!append) setLoad({ state: 'failed' });
      return;
    }
    const page = answer.body;
    setLoad((previous) => ({
      state: 'ready',
      items: append && previous.state === 'ready' ? [...previous.items, ...page.items] : page.items,
      nextAfterId: page.nextAfterId,
      scanned: (append && previous.state === 'ready' ? previous.scanned : 0) + page.scanned,
      unreadable: [
        ...new Set([
          ...(append && previous.state === 'ready' ? previous.unreadable : []),
          ...page.unreadableFeatureSets,
        ]),
      ],
    }));
  }, []);

  useEffect(() => {
    void fetchPage(null, false);
  }, [fetchPage]);

  const items = load.state === 'ready' ? load.items : [];
  const featureSets = useMemo(
    () => [...new Set(items.map((item) => item.featureSetCode))].sort(),
    [items],
  );
  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return items.filter(
      (item) =>
        (featureSet === '' || item.featureSetCode === featureSet) &&
        (needle === '' ||
          item.productCode.toLowerCase().includes(needle) ||
          (item.name ?? '').toLowerCase().includes(needle) ||
          (item.sellerId ?? '').toLowerCase().includes(needle)),
    );
  }, [items, search, featureSet]);
  const chosen = shown.filter((item) => selected.has(item.productId));
  const askable = emailable(chosen);

  function toggle(productId: string, on: boolean) {
    setSelected((previous) => {
      const next = new Set(previous);
      if (on) next.add(productId);
      else next.delete(productId);
      return next;
    });
  }

  function exportCsv() {
    const blob = new Blob([csvOf(chosen.length > 0 ? chosen : shown)], {
      type: 'text/csv;charset=utf-8',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'products-missing-details.csv';
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section
      aria-label={t('label')}
      aria-busy={load.state === 'loading'}
      className="flex flex-col gap-4"
    >
      <Banner tone="info" title={t('info.title')}>
        {t('info.body')}
      </Banner>
      {load.state === 'loading' ? <SkeletonRows label={t('loading')} rows={4} /> : null}
      {load.state === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('load-error')}
          retryLabel={tl('retry')}
          onRetry={() => void fetchPage(null, false)}
        />
      ) : null}
      {load.state === 'ready' && load.unreadable.length > 0 ? (
        <Banner tone="attention" title={t('unreadable.title')}>
          {t('unreadable.body', { codes: load.unreadable.join(', ') })}
        </Banner>
      ) : null}
      {load.state === 'ready' && load.items.length === 0 && load.nextAfterId === null ? (
        <EmptyState size="card" icon="inbox" title={t('empty')} body={t('empty-body')} />
      ) : null}
      {load.state === 'ready' && (load.items.length > 0 || load.nextAfterId !== null) ? (
        <>
          <div className="flex flex-wrap items-end gap-3">
            <SearchField
              className="min-w-56 flex-1"
              label={t('search-label')}
              placeholder={t('search-placeholder')}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
            <Select
              label={t('feature-set')}
              placeholder={t('all-feature-sets')}
              options={featureSets.map((code) => ({ value: code, label: code }))}
              value={featureSet}
              onChange={(event) => setFeatureSet(event.target.value)}
            />
            <Button variant="secondary" disabled={shown.length === 0} onClick={exportCsv}>
              {chosen.length > 0 ? t('export-selected', { count: chosen.length }) : t('export')}
            </Button>
            {canEdit ? (
              <Button
                variant="secondary"
                disabled={askable.length === 0 || askable.length > 200}
                aria-describedby="email-sellers-note"
                onClick={() => setEmailing(true)}
              >
                {t('email.button')}
              </Button>
            ) : null}
          </div>
          {canEdit ? (
            <p id="email-sellers-note" className="m-0 text-sm text-fg-muted">
              {askable.length === 0
                ? t('email.pick')
                : askable.length > 200
                  ? t('email.too-many')
                  : t('email.picked', { count: askable.length })}
            </p>
          ) : null}
          {emailed === null ? null : (
            <Banner tone="success">{t('email.sent', { count: emailed })}</Banner>
          )}
          <p className="text-sm text-fg-muted" aria-live="polite">
            {t('totals', { shown: shown.length, loaded: load.items.length, scanned: load.scanned })}
          </p>
          {shown.length === 0 ? (
            <EmptyState size="card" icon="search" title={t('no-match')} body={t('no-match-body')} />
          ) : (
            <ul
              role="list"
              className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface"
            >
              {shown.map((item) => (
                <li key={item.productId} className="flex items-start gap-3 px-4 py-3">
                  <CheckboxRow
                    label={t('select-row', { code: item.productCode })}
                    checked={selected.has(item.productId)}
                    onChange={(event) => toggle(item.productId, event.target.checked)}
                  />
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <p className="font-medium wrap-anywhere text-fg">
                      {item.name ?? t('unnamed')}
                      <span className="ms-2 text-sm font-normal text-fg-muted">
                        {item.productCode}
                      </span>
                    </p>
                    <p className="text-sm text-fg-muted wrap-anywhere">
                      {item.sellerId === null
                        ? t('platform-product')
                        : t('seller', { id: item.sellerId })}
                      {' · '}
                      {t('feature-set-named', { code: item.featureSetCode })}
                    </p>
                    <ul role="list" aria-label={t('missing')} className="flex flex-wrap gap-1.5">
                      {item.missing.map((code) => (
                        <li key={code}>
                          <Badge tone="attention">{code}</Badge>
                        </li>
                      ))}
                    </ul>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {load.nextAfterId === null ? null : (
            <div>
              <Button
                variant="secondary"
                loading={more}
                disabled={more}
                onClick={() => void fetchPage(load.nextAfterId, true)}
              >
                {t('load-more')}
              </Button>
            </div>
          )}
        </>
      ) : null}
      {emailing ? (
        <EmailSellersDialog
          rows={chosen}
          csrfToken={csrfToken}
          onClose={() => setEmailing(false)}
          onSent={(sellers) => {
            setEmailing(false);
            setEmailed(sellers);
            setSelected(new Set());
          }}
        />
      ) : null}
    </section>
  );
}
