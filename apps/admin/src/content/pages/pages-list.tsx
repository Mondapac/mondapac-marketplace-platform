'use client';

import {
  Banner,
  Button,
  EmptyState,
  LinkButton,
  LoadError,
  Select,
  SkeletonRows,
  TextField,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { NO_PAGE_FILTERS, filterPages, type PageFilters } from './page-filter.ts';
import {
  NEW_PAGE_PATH,
  PAGES_API_PATH,
  PAGE_STATUSES,
  listedPages,
  type PageList,
  type PageSummary,
} from './page-types.ts';
import { PagesTable } from './pages-table.tsx';

type Load = 'loading' | 'ready' | 'failed';

const TOGGLE =
  'inline-flex h-(--mp-size-control) items-center rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-focus';

/**
 * The pages of the Market, system and dynamic. Every page is loaded once; the type, the status
 * and the title filter the answer in the browser. Loading, empty, no match and load error each
 * have a state. Without an edit key the list is read-only (a note says so).
 */
export function PagesList({
  canEdit,
  canCreate,
  zone,
}: {
  readonly canEdit: boolean;
  readonly canCreate: boolean;
  readonly zone: string;
}) {
  const t = useTranslations('content.pages.list');
  const status = useTranslations('content.pages.status');
  const tl = useTranslations('load');
  const [filters, setFilters] = useState<PageFilters>(NO_PAGE_FILTERS);
  const [pages, setPages] = useState<readonly PageSummary[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const latest = useRef(0);

  const fetchPages = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    const result = await callApi<PageList>('GET', PAGES_API_PATH);
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setPages([]);
      setLoad('failed');
      return;
    }
    setPages(listedPages(result.body.pages));
    setLoad('ready');
  }, []);

  useEffect(() => {
    void fetchPages();
  }, [fetchPages]);

  const shown = useMemo(() => filterPages(pages, filters), [pages, filters]);
  // Nothing to filter yet: the header's "New page" button is the one call to action.
  const trulyEmpty = load === 'ready' && pages.length === 0;
  return (
    <div className="flex flex-col gap-4">
      {canEdit || load !== 'ready' ? null : <Banner tone="info">{t('read-only')}</Banner>}
      {trulyEmpty || load !== 'ready' ? null : (
        <div role="search" aria-label={t('filters')} className="flex flex-wrap items-end gap-3">
          <div role="group" aria-label={t('type')} className="flex flex-wrap items-center gap-2">
            {(['all', 'system', 'dynamic'] as const).map((kind) => {
              const on = filters.kind === kind;
              return (
                <button
                  key={kind}
                  type="button"
                  aria-pressed={on}
                  onClick={() => setFilters({ ...filters, kind })}
                  className={`${TOGGLE} ${on ? 'border-accent bg-selected font-medium text-link' : 'border-line-control bg-surface text-fg hover:bg-muted'}`}
                >
                  {t(`kind.${kind}`)}
                </button>
              );
            })}
          </div>
          <div className="w-full sm:w-48">
            <Select
              label={t('status')}
              value={filters.status}
              placeholder={t('any-status')}
              options={PAGE_STATUSES.map((value) => ({ value, label: status(value) }))}
              onChange={(event) => setFilters({ ...filters, status: event.target.value })}
            />
          </div>
          <div className="w-full sm:min-w-56 sm:flex-1">
            <TextField
              label={t('search')}
              type="search"
              value={filters.search}
              autoComplete="off"
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
            />
          </div>
        </div>
      )}
      {load === 'loading' ? <SkeletonRows label={t('loading')} rows={5} /> : null}
      {load === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error')}
          retryLabel={tl('retry')}
          onRetry={() => void fetchPages()}
        />
      ) : null}
      {load === 'ready' && shown.length > 0 ? (
        <>
          <p className="text-sm text-fg-muted" aria-live="polite">
            {t('count', { count: shown.length })}
          </p>
          <PagesTable rows={shown} zone={zone} />
          <p className="text-sm text-fg-muted">{t('footnote', { zone })}</p>
        </>
      ) : null}
      {trulyEmpty ? (
        <EmptyState
          icon="layout"
          title={t('empty-title')}
          body={t('empty-body')}
          action={canCreate ? <LinkButton href={NEW_PAGE_PATH}>{t('new')}</LinkButton> : undefined}
        />
      ) : null}
      {load === 'ready' && shown.length === 0 && !trulyEmpty ? (
        <EmptyState
          icon="search"
          title={t('none-title')}
          body={t('none-body')}
          action={
            <Button variant="secondary" onClick={() => setFilters(NO_PAGE_FILTERS)}>
              {t('clear')}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}
