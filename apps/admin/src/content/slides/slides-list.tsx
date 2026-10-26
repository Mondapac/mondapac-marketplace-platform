'use client';

import { Banner, Button, EmptyState, LoadError, SkeletonRows } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { FilterBar, NO_FILTERS, type FilterValues } from './filter-bar.tsx';
import { filterSlides } from './slide-filter.ts';
import {
  SLIDES_API_PATH,
  sortSlides,
  type SlideDetail,
  type SlideList,
  type SlideSummary,
} from './slide-types.ts';
import { SlidesTable } from './slides-table.tsx';

type Load = 'loading' | 'ready' | 'failed';

/**
 * The slides of the Market. The position and the status are asked of the API; the type and the
 * name filter the answer in the browser. Loading, empty, no match and load error each have a state.
 */
export function SlidesList({
  permissionKeys,
  zone,
  csrfToken,
}: {
  readonly permissionKeys: readonly string[];
  /** The IANA zone the live windows are shown in. */
  readonly zone: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('content.slides.list');
  const tl = useTranslations('load');
  const [filters, setFilters] = useState<FilterValues>(NO_FILTERS);
  const [slides, setSlides] = useState<readonly SlideSummary[]>([]);
  const [load, setLoad] = useState<Load>('loading');
  const [notice, setNotice] = useState<{ tone: 'success' | 'info'; text: string } | null>(null);
  const latest = useRef(0);
  const { position, status } = filters;

  const fetchSlides = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    const query = new URLSearchParams();
    if (status !== '') query.set('state', status);
    if (position !== '') query.set('position', position);
    const text = query.toString();
    const result = await callApi<SlideList>(
      'GET',
      `${SLIDES_API_PATH}${text === '' ? '' : `?${text}`}`,
    );
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setSlides([]);
      setLoad('failed');
      return;
    }
    setSlides(sortSlides(result.body.slides));
    setLoad('ready');
  }, [position, status]);

  useEffect(() => {
    void fetchSlides();
  }, [fetchSlides]);

  // A command on a row worked: the row shows the slide as it is now, without reloading the list.
  const changed = useCallback(
    (detail: SlideDetail) => {
      const row: SlideSummary = {
        id: detail.id,
        kind: detail.kind,
        internalName: detail.internalName,
        status: detail.status,
        startsAt: detail.startsAt,
        endsAt: detail.endsAt,
        pinned: detail.pinned,
        sponsored: detail.sponsored,
        hasDraft: detail.hasDraft,
        positions: detail.positions,
        updatedAt: detail.updatedAt,
      };
      setSlides((previous) =>
        sortSlides(previous.map((slide) => (slide.id === row.id ? row : slide))),
      );
      setNotice({
        tone: 'success',
        text: t(row.status === 'paused' ? 'done-paused' : 'done-resumed', {
          name: row.internalName,
        }),
      });
    },
    [t],
  );
  const stale = useCallback(() => {
    setNotice({ tone: 'info', text: t('stale') });
    void fetchSlides();
  }, [t, fetchSlides]);

  const shown = useMemo(() => filterSlides(slides, filters), [slides, filters]);
  const filtered =
    filters.kind !== 'all' ||
    filters.position !== '' ||
    filters.status !== '' ||
    filters.search.trim() !== '';
  // Nothing to filter yet: the header's "New slide" button is the one call to action.
  const trulyEmpty = load === 'ready' && slides.length === 0 && !filtered;

  return (
    <div className="flex flex-col gap-4">
      {trulyEmpty ? null : <FilterBar values={filters} onChange={setFilters} />}
      {notice === null ? null : <Banner tone={notice.tone}>{notice.text}</Banner>}
      {load === 'loading' ? <SkeletonRows label={t('loading')} rows={4} /> : null}
      {load === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error')}
          retryLabel={tl('retry')}
          onRetry={() => void fetchSlides()}
        />
      ) : null}
      {load === 'ready' && shown.length > 0 ? (
        <>
          <p className="text-sm text-fg-muted" aria-live="polite">
            {t('count', { count: shown.length })}
          </p>
          <SlidesTable
            rows={shown}
            permissionKeys={permissionKeys}
            zone={zone}
            csrfToken={csrfToken}
            onChanged={changed}
            onStale={stale}
          />
          <p className="text-sm text-fg-muted">{t('footnote', { zone })}</p>
        </>
      ) : null}
      {trulyEmpty ? (
        <EmptyState
          icon="layout"
          title={t('empty-title')}
          body={t('empty-body')}
          action={<p className="text-sm text-fg-muted">{t('empty-note')}</p>}
        />
      ) : null}
      {load === 'ready' && shown.length === 0 && !trulyEmpty ? (
        <EmptyState
          icon="search"
          title={t('none-title')}
          body={t('none-body')}
          action={
            <Button variant="secondary" onClick={() => setFilters(NO_FILTERS)}>
              {t('clear')}
            </Button>
          }
        />
      ) : null}
    </div>
  );
}
