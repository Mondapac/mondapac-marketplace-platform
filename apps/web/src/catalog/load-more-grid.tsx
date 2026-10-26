'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ProductCard } from '../home/product-card.tsx';
import type { ShelfCard } from '../storefront/types.ts';
import { loadMoreProducts, type LoadMoreRequest } from './load-more.ts';
import { MAX_THROUGH, listingHref, type ListingState } from './listing-state.ts';

// A phone listing's product grid with "Load more" (buyer mobile plan, M3). The server renders the
// pages `state.page` to `through`; Load more appends the next page and writes `?through=N` to the
// address with replaceState, so back, refresh and a shared link show the same list. Until the
// script has run the button stays hidden and the numbered pager (children) is the way on; on
// tablet and desktop CSS always shows the pager. Strings and counts come from messages and data.

interface Props {
  readonly items: readonly ShelfCard[];
  /** The last page the items hold. */
  readonly through: number;
  readonly hasMore: boolean;
  /** Matching products; absent when the source gives no total (the API). */
  readonly total?: number;
  readonly pageSize: number;
  readonly scope: LoadMoreRequest['scope'];
  readonly state: ListingState;
  /** The listing's address (with the search words), for the link that takes over at the limit. */
  readonly path: string;
  /** The numbered pager, which the phone hides once Load more works. */
  readonly children?: ReactNode;
}

/** The listing's filters and sort as a query string, without the page. */
function queryOf(state: ListingState): string {
  const href = listingHref('/', { ...state, page: 1 });
  return href.split('?', 2)[1] ?? '';
}

export function LoadMoreGrid({
  items,
  through,
  hasMore,
  total,
  pageSize,
  scope,
  state,
  path,
  children,
}: Props) {
  const t = useTranslations('catalog');
  const [loaded, setLoaded] = useState(items);
  const [last, setLast] = useState(through);
  const [more, setMore] = useState(hasMore);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [ready, setReady] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const grid = useRef<HTMLDivElement>(null);
  const focusAt = useRef<number | null>(null);

  useEffect(() => setReady(true), []);

  // After an append, focus goes to the first new product so keyboard and screen reader users
  // continue from there.
  useEffect(() => {
    const index = focusAt.current;
    if (index === null) return;
    focusAt.current = null;
    grid.current?.children[index]?.querySelector<HTMLElement>('a')?.focus({ preventScroll: true });
  }, [loaded]);

  const shown = (state.page - 1) * pageSize + loaded.length;
  const count =
    total !== undefined
      ? t('showing', { shown: Math.min(shown, total), total })
      : t('showing-some', { shown });

  const loadMore = async () => {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    try {
      const next = last + 1;
      const page = await loadMoreProducts({ scope, query: queryOf(state), page: next });
      if (page === null) throw new Error('load-more refused');
      const known = new Set(loaded.map((p) => p.id));
      const added = page.items.filter((p) => !known.has(p.id));
      const all = [...loaded, ...added];
      focusAt.current = loaded.length;
      setLoaded(all);
      setLast(next);
      setMore(page.hasMore);
      const now = (state.page - 1) * pageSize + all.length;
      setAnnouncement(
        total !== undefined
          ? t('loaded', { count: added.length, shown: Math.min(now, total), total })
          : t('loaded-some', { count: added.length, shown: now }),
      );
      const url = new URL(window.location.href);
      url.searchParams.set('through', String(next));
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}`);
    } catch {
      focusAt.current = null;
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lm-wrap" data-lm={ready ? 'on' : 'off'}>
      <div className="grid" ref={grid}>
        {loaded.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
      <div className="lm">
        <p className="lm-count num">{count}</p>
        {more && last >= MAX_THROUGH ? (
          <Link className="btn ghost lm-btn" href={listingHref(path, { ...state, page: last + 1 })}>
            {t('next-page')}
          </Link>
        ) : more ? (
          <button
            className="btn ghost lm-btn"
            type="button"
            onClick={() => void loadMore()}
            aria-busy={busy}
          >
            {busy ? t('loading-more') : t('load-more')}
          </button>
        ) : null}
        {failed ? (
          <p className="lm-error" role="alert">
            {t('load-more-failed')}
          </p>
        ) : null}
        <p className="sr-only" role="status" aria-live="polite">
          {announcement}
        </p>
      </div>
      {children}
    </div>
  );
}
