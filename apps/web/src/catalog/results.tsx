import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ProductCard } from '../home/product-card.tsx';
import { Icon } from '../icons/icon.tsx';
import type { ProductPage } from '../storefront/catalog.ts';
import { BrowseCrumb } from './browse-crumb.tsx';
import { LoadMoreGrid } from './load-more-grid.tsx';
import type { LoadMoreRequest } from './load-more.ts';
import type { ListingState } from './listing-state.ts';

// The parts the category and search pages share: breadcrumb, heading row, filter chips, the
// product grid of v29 and the pager. The API gives `hasMore` and no total, so the pager offers
// the previous and the next page only.

/** A link of the trail, or the "Browse products" step that opens the Browse panel. */
export type Crumb =
  | { readonly label: string; readonly href: string }
  | { readonly label: string; readonly browse: true };

export function Crumbs({
  trail,
  current,
}: {
  readonly trail: readonly Crumb[];
  readonly current: string;
}) {
  const t = useTranslations('catalog');
  return (
    <nav className="crumbs" aria-label={t('breadcrumb')}>
      <ol>
        {trail.map((crumb) => (
          <li key={'href' in crumb ? crumb.href : 'browse'}>
            {'href' in crumb ? (
              <Link href={crumb.href}>{crumb.label}</Link>
            ) : (
              <BrowseCrumb label={crumb.label} />
            )}
            <Icon name="chevr" />
          </li>
        ))}
        <li aria-current="page">{current}</li>
      </ol>
    </nav>
  );
}

export function ResultsHead({
  title,
  crumbs,
  children,
}: {
  readonly title: string;
  readonly crumbs?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <div className="rhead">
      {crumbs}
      <h1>{title}</h1>
      {children}
    </div>
  );
}

/**
 * The product grid with its pager, or `empty` when the page holds no products. Without `pager`
 * it pages by previous and next (the search route gives no total).
 */
export function ProductResults({
  result,
  hrefFor,
  empty,
  pager,
  loadMore,
}: {
  readonly result: ProductPage;
  readonly hrefFor: (page: number) => string;
  readonly empty: ReactNode;
  readonly pager?: ReactNode;
  /** Gives the phone a "Load more" button; `result` then holds the pages `state.page` to `through`. */
  readonly loadMore?: {
    readonly scope: LoadMoreRequest['scope'];
    readonly state: ListingState;
    readonly path: string;
    readonly through: number;
  };
}) {
  const t = useTranslations('catalog');
  if (result.items.length === 0) {
    // A page past the last one (an old link) points back to the first page.
    if (result.page > 1)
      return (
        <div className="empty rich">
          <p role="status">{t('page-empty')}</p>
          <Link className="btn" href={hrefFor(1)}>
            {t('first-page')}
          </Link>
        </div>
      );
    return empty;
  }
  const previous = result.page > 1;
  const at = loadMore?.through ?? result.page;
  const pagerNode =
    pager !== undefined ? (
      pager
    ) : previous || result.hasMore ? (
      <nav className="pager" aria-label={t('pages')}>
        {previous ? (
          <Link href={hrefFor(result.page - 1)} rel="prev">
            <Icon name="chevl" />
            {t('previous')}
          </Link>
        ) : (
          <span />
        )}
        <span className="at">{t('page', { page: at })}</span>
        {result.hasMore ? (
          <Link href={hrefFor(at + 1)} rel="next">
            {t('next')}
            <Icon name="chevr" />
          </Link>
        ) : (
          <span />
        )}
      </nav>
    ) : null;
  return (
    <section aria-labelledby="results-heading">
      <h2 id="results-heading" className="sr-only">
        {t('results')}
      </h2>
      {loadMore ? (
        <LoadMoreGrid
          key={`${loadMore.path}|${JSON.stringify(loadMore.state)}|${loadMore.through}`}
          items={result.items}
          through={loadMore.through}
          hasMore={result.hasMore}
          {...(result.total === undefined ? {} : { total: result.total })}
          pageSize={result.pageSize}
          scope={loadMore.scope}
          state={loadMore.state}
        >
          {pagerNode}
        </LoadMoreGrid>
      ) : (
        <>
          <div className="grid">
            {result.items.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
          {pagerNode}
        </>
      )}
    </section>
  );
}

/** The no-products state: a message and up to a few ways on. */
export function EmptyResults({
  message,
  children,
}: {
  readonly message: string;
  readonly children?: ReactNode;
}) {
  return (
    <div className="empty rich">
      <p role="status">{message}</p>
      {children}
    </div>
  );
}

/** The loading state of a results page, shaped like the page so nothing jumps when it lands. */
export function ResultsLoading({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-label={label} className="loading">
      <div className="rhead">
        <div className="skel line" />
        <div className="skel title" />
      </div>
      <div className="fchips" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skel chip" />
        ))}
      </div>
      <div className="grid">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skel card" />
        ))}
      </div>
    </div>
  );
}
