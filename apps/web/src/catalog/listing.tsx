import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { Icon } from '../icons/icon.tsx';
import type { ListingFacets } from '../storefront/catalog.ts';
import type { ListingBanner } from '../storefront/types.ts';
import { priceBandLabel } from './filter-labels.ts';
import {
  listingHref,
  withFlag,
  withoutFilters,
  withPage,
  withValue,
  type FilterGroup,
  type ListingState,
} from './listing-state.ts';

// The server-rendered parts of the product listing page (approved prototype v7): the promotion
// banner, the filters in use, the result count and the numbered pager. Filter changes are plain
// links to the listing's URL, so they work before the page's script loads.

export function ListingBannerView({ banner }: { readonly banner: ListingBanner }) {
  const t = useTranslations('catalog');
  return (
    <section className="cban" aria-label={t('promotion')}>
      <span className="cbi">
        <Icon name="tag" />
      </span>
      <div className="cbt">
        <h2>{banner.title}</h2>
        <p>{banner.body}</p>
      </div>
      <Link className="btn alt" href={banner.action.href}>
        {banner.action.label}
      </Link>
      {banner.imageUrl ? (
        <img className="cbp" src={banner.imageUrl} alt="" loading="lazy" decoding="async" />
      ) : null}
    </section>
  );
}

/** A removable chip of a filter in use that the listing state does not hold (search's category). */
export interface ExtraFilter {
  readonly key: string;
  readonly label: string;
  /** The URL without this filter. */
  readonly href: string;
}

/** The removable chips of the filters in use, and "Clear all" (the result count announces). */
export function ActiveFilters({
  path,
  state,
  facets,
  extra = [],
  clearHref,
}: {
  readonly path: string;
  readonly state: ListingState;
  readonly facets: ListingFacets;
  /** Chips shown first; "Clear all" then goes to `clearHref`. */
  readonly extra?: readonly ExtraFilter[];
  readonly clearHref?: string;
}) {
  const t = useTranslations('catalog');
  const locale = useLocale();
  const { filters } = state;
  const chips: ExtraFilter[] = [...extra];
  const flag = (on: boolean, key: 'special' | 'sameDay' | 'lowStock', label: string) => {
    if (on) chips.push({ key, label, href: listingHref(path, withFlag(state, key, false)) });
  };
  const group = (key: FilterGroup, ids: readonly string[], label: (id: string) => string) => {
    for (const id of ids)
      chips.push({
        key: `${key}:${id}`,
        label: label(id),
        href: listingHref(path, withValue(state, key, id, false)),
      });
  };
  flag(filters.special, 'special', t('special-prices'));
  group('certifications', filters.certifications, (id) => {
    const name = facets.certifications.find((c) => c.id === id)?.name;
    return name ?? id;
  });
  flag(filters.sameDay, 'sameDay', t('same-day'));
  flag(filters.lowStock, 'lowStock', t('low-stock'));
  group('sellers', filters.sellers, (id) => facets.sellers.find((s) => s.id === id)?.name ?? id);
  group('prices', filters.prices, (id) => {
    const band = facets.prices.find((p) => p.id === id)?.band;
    return band ? priceBandLabel(band, t, locale) : id;
  });

  return (
    <div className="act" aria-label={t('active-filters')} role="group">
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={chip.href}
          scroll={false}
          aria-label={t('remove-filter', { name: chip.label })}
        >
          {chip.label}
          <Icon name="close" />
        </Link>
      ))}
      {chips.length > 0 ? (
        <Link
          className="clr"
          href={clearHref ?? listingHref(path, withoutFilters(state))}
          scroll={false}
        >
          {t('clear-all')}
        </Link>
      ) : null}
    </div>
  );
}

/** "1 - 12 of 31 results". */
export function ResultCount({
  page,
  pageSize,
  total,
}: {
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}) {
  const t = useTranslations('catalog');
  const from = Math.min(total, (page - 1) * pageSize + 1);
  const to = Math.min(total, page * pageSize);
  return (
    <p className="cnt num" aria-live="polite">
      {total > 0 ? t('count', { from, to, total }) : t('count-none')}
    </p>
  );
}

/** The page numbers to show: all of them up to 7, else the ends and the current page's neighbours. */
export function pageWindow(page: number, pages: number): (number | 'gap')[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const shown = [1, page - 1, page, page + 1, pages].filter((n) => n >= 1 && n <= pages);
  const out: (number | 'gap')[] = [];
  for (const n of [...new Set(shown)].sort((a, b) => a - b)) {
    const last = out.at(-1);
    if (typeof last === 'number' && n - last > 1) out.push('gap');
    out.push(n);
  }
  return out;
}

/** Previous, the page numbers and Next; shown only when there is more than one page. */
export function NumberedPager({
  path,
  state,
  pages,
}: {
  readonly path: string;
  readonly state: ListingState;
  readonly pages: number;
}) {
  const t = useTranslations('catalog');
  if (pages <= 1) return null;
  const href = (page: number) => listingHref(path, withPage(state, page));
  const { page } = state;
  return (
    <nav className="pager nums" aria-label={t('pages')}>
      {page > 1 ? (
        <Link href={href(page - 1)} rel="prev" aria-label={t('previous-page')}>
          <Icon name="chevl" />
        </Link>
      ) : (
        <span aria-disabled="true" aria-label={t('previous-page')} role="link">
          <Icon name="chevl" />
        </span>
      )}
      {pageWindow(page, pages).map((n, i) =>
        n === 'gap' ? (
          <span key={`gap-${i}`} className="gap" aria-hidden="true">
            …
          </span>
        ) : (
          <Link
            key={n}
            href={href(n)}
            className="num"
            aria-current={n === page ? 'page' : undefined}
            aria-label={t('page', { page: n })}
          >
            {n}
          </Link>
        ),
      )}
      {page < pages ? (
        <Link href={href(page + 1)} rel="next" aria-label={t('next-page')}>
          <Icon name="chevr" />
        </Link>
      ) : (
        <span aria-disabled="true" aria-label={t('next-page')} role="link">
          <Icon name="chevr" />
        </span>
      )}
    </nav>
  );
}
