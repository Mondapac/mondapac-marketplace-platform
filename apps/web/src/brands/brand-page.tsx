import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { BrowseCrumb } from '../catalog/browse-crumb.tsx';
import { Crumbs } from '../catalog/results.tsx';
import { ProductCard } from '../home/product-card.tsx';
import { Icon } from '../icons/icon.tsx';
import type { BrandPage as BrandPageData } from '../storefront/types.ts';
import { BrandHeaderPicture, BrandLogo } from './brand-pictures.tsx';

// The brand page (design B5, `/brands/<slug>`): the crumb, the header card (the picture, the logo on
// its edge, the name, the summary and the facts), then the brand's products from every seller. The
// short list under the header ends with "See all N"; that opens the full list, 24 to a page with
// the site's numbered pager. The design's "Sold by N sellers" fact and its "Stories" strip wait for
// data the API does not give yet (the sellers of a brand; the blog's brand link), so they are not
// drawn.

/** The fragment (and element id) of the products section, so a page change lands on the list. */
export const BRAND_PRODUCTS_ANCHOR = 'brand-products';

export const brandHref = (slug: string, all: boolean, page: number): string => {
  const path = `/brands/${encodeURIComponent(slug)}`;
  if (!all) return path;
  return `${path}?all=1${page > 1 ? `&page=${page}` : ''}#${BRAND_PRODUCTS_ANCHOR}`;
};

/** The English-or-other name of a country for its ISO code, in the page's language. */
function countryName(code: string, locale: string): string | undefined {
  try {
    return new Intl.DisplayNames([locale], { type: 'region' }).of(code) ?? undefined;
  } catch {
    return undefined;
  }
}

export function BrandPage({ page }: { readonly page: BrandPageData }) {
  const t = useTranslations('brands');
  const locale = useLocale();
  const { brand, products, all } = page;
  const country = brand.originCountry ? countryName(brand.originCountry, locale) : undefined;
  const shown = products.kind === 'ok' ? products.items.length : 0;
  // The short list links on only when the brand has more live products than it shows.
  const more = !all && brand.productCount > shown && shown > 0;
  return (
    <div className="br">
      <Crumbs
        trail={[
          { label: t('home'), href: '/' },
          { label: t('title'), href: '/brands' },
        ]}
        current={brand.name}
      />
      <header className="br-head">
        <BrandHeaderPicture image={brand.header} />
        <div className="br-body">
          <BrandLogo name={brand.name} logo={brand.logo} size="lg" />
          <div className="br-title">
            <h1>{brand.name}</h1>
            {brand.summary === undefined ? null : <p className="br-summary">{brand.summary}</p>}
            <p className="br-meta">
              {country === undefined ? null : (
                <span>
                  <Icon name="pin" />
                  {t('made-in', { country })}
                </span>
              )}
              <span>
                <Icon name="box" />
                {t('product-count', { count: brand.productCount })}
              </span>
            </p>
          </div>
        </div>
      </header>
      <section id={BRAND_PRODUCTS_ANCHOR} className="br-products" aria-labelledby="br-products-h">
        <div className="br-sech">
          <h2 id="br-products-h">{all ? t('all-products') : t('products')}</h2>
          {more ? (
            <Link href={brandHref(brand.slug, true, 1)}>
              {t('see-all', { count: brand.productCount })}
            </Link>
          ) : null}
          {all ? <Link href={brandHref(brand.slug, false, 1)}>{t('back-to-brand')}</Link> : null}
        </div>
        <Products page={page} />
      </section>
    </div>
  );
}

function Products({ page }: { readonly page: BrandPageData }) {
  const t = useTranslations('brands');
  const { brand, products, all } = page;
  if (products.kind === 'failed')
    return (
      <div className="shop-empty" role="alert">
        <Icon name="info" />
        <h3>{t('products-failed')}</h3>
        <p>{t('products-failed-body')}</p>
        {/* A plain link: a full request, so the read really runs again. */}
        <a className="btn ghost" href={brandHref(brand.slug, all, products.page)}>
          {t('try-again')}
        </a>
      </div>
    );
  const { items, hasMore } = products;
  const current = products.page;
  if (items.length === 0 && current === 1)
    return (
      <div className="shop-empty">
        <Icon name="box" />
        <h3>{t('no-products')}</h3>
        <p>{t('no-products-body', { name: brand.name })}</p>
        <BrowseCrumb className="btn" label={t('browse-products')} />
      </div>
    );
  if (items.length === 0)
    return (
      <div className="shop-empty">
        <Icon name="search" />
        <h3>{t('page-empty')}</h3>
        <Link className="btn ghost" href={brandHref(brand.slug, true, 1)}>
          {t('first-page')}
        </Link>
      </div>
    );
  return (
    <>
      <div className="shop-grid">
        {items.map((p) => (
          <ProductCard key={p.id} product={p} />
        ))}
      </div>
      {all && (current > 1 || hasMore) ? (
        <nav className="pager nums shop-pager" aria-label={t('page-nav')}>
          {current > 1 ? (
            <Link
              href={brandHref(brand.slug, true, current - 1)}
              rel="prev"
              aria-label={t('previous-page')}
            >
              <Icon name="chevl" />
            </Link>
          ) : (
            <span aria-disabled="true" aria-label={t('previous-page')}>
              <Icon name="chevl" />
            </span>
          )}
          <Link
            href={brandHref(brand.slug, true, current)}
            className="num"
            aria-current="page"
            aria-label={t('page-number', { page: current })}
          >
            {current}
          </Link>
          {hasMore ? (
            <Link
              href={brandHref(brand.slug, true, current + 1)}
              rel="next"
              aria-label={t('next-page')}
            >
              <Icon name="chevr" />
            </Link>
          ) : (
            <span aria-disabled="true" aria-label={t('next-page')}>
              <Icon name="chevr" />
            </span>
          )}
        </nav>
      ) : null}
    </>
  );
}

/** The route's loading state: the header card and a grid of grey product cards. */
export function BrandLoading({ label }: { readonly label: string }) {
  return (
    <div className="br" role="status" aria-label={label} aria-busy="true">
      <div className="skel title" aria-hidden="true" />
      <div className="skel br-skel-head" aria-hidden="true" />
      <div className="shop-grid" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skel br-skel-card" />
        ))}
      </div>
    </div>
  );
}
