import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ProductCard } from '../home/product-card.tsx';
import { Icon } from '../icons/icon.tsx';
import type { ProductPage } from '../storefront/catalog.ts';

// The parts the category and search pages share: breadcrumb, heading row, filter chips, the
// product grid of v29 and the pager. The API gives `hasMore` and no total, so the pager offers
// the previous and the next page only.

export interface Crumb {
  readonly label: string;
  readonly href: string;
}

export interface Chip {
  readonly label: string;
  readonly href: string;
  readonly current: boolean;
}

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
          <li key={crumb.href}>
            <Link href={crumb.href}>{crumb.label}</Link>
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

export function FilterChips({
  label,
  chips,
}: {
  readonly label: string;
  readonly chips: readonly Chip[];
}) {
  if (chips.length === 0) return null;
  return (
    <nav className="fchips" aria-label={label}>
      {chips.map((chip) => (
        <Link
          key={chip.href}
          href={chip.href}
          aria-current={chip.current ? 'page' : undefined}
          scroll={false}
        >
          {chip.label}
        </Link>
      ))}
    </nav>
  );
}

/** The product grid with its pager, or `empty` when the page holds no products. */
export function ProductResults({
  result,
  hrefFor,
  empty,
}: {
  readonly result: ProductPage;
  readonly hrefFor: (page: number) => string;
  readonly empty: ReactNode;
}) {
  const t = useTranslations('catalog');
  if (result.items.length === 0) {
    // A page past the last one (an old link) points back to the first page.
    if (result.page > 1)
      return (
        <div className="empty rich">
          <p>{t('page-empty')}</p>
          <Link className="btn" href={hrefFor(1)}>
            {t('first-page')}
          </Link>
        </div>
      );
    return empty;
  }
  const previous = result.page > 1;
  return (
    <section aria-label={t('results')}>
      <div className="grid">
        {result.items.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
      {previous || result.hasMore ? (
        <nav className="pager" aria-label={t('pages')}>
          {previous ? (
            <Link href={hrefFor(result.page - 1)} rel="prev">
              <Icon name="chevl" />
              {t('previous')}
            </Link>
          ) : (
            <span />
          )}
          <span className="at">{t('page', { page: result.page })}</span>
          {result.hasMore ? (
            <Link href={hrefFor(result.page + 1)} rel="next">
              {t('next')}
              <Icon name="chevr" />
            </Link>
          ) : (
            <span />
          )}
        </nav>
      ) : null}
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
    <div className="empty rich" role="status">
      <p>{message}</p>
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
