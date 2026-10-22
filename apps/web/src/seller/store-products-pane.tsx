'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { ProductCard } from '../home/product-card.tsx';
import { Icon } from '../icons/icon.tsx';
import type { SellerShop, StoreProducts } from '../storefront/types.ts';

// The Products tab of a real store: one page of the store's cards from the API, in name order,
// with the site's numbered pager (Previous, the current page, Next; fixed slots, a disabled one
// is a dimmed span). The page number is in the URL, so a page can be shared and the back button
// works; every link carries the fragment of the panel, so after a page change the panel is in
// view and its focus target takes focus. No search box, sort or category chips: the API lists by
// name and gives no total, so those would act on one page only and mislead. A failed read is said
// inside the tab, with a link that reads the same page again.

/** The fragment (and element id) of the Products panel. */
export const PRODUCTS_ANCHOR = 'store-products';

const href = (shop: SellerShop, page: number): string =>
  `${page === 1 ? `/s/${shop.id}` : `/s/${shop.id}?page=${page}`}#${PRODUCTS_ANCHOR}`;

export function StoreProductsPane({
  shop,
  products,
}: {
  readonly shop: SellerShop;
  readonly products: StoreProducts;
}) {
  const t = useTranslations('seller');
  const target = useRef<HTMLDivElement>(null);
  // After a page change (the URL still carries the fragment) the focus goes to the panel.
  useEffect(() => {
    if (window.location.hash === `#${PRODUCTS_ANCHOR}`) target.current?.focus();
  }, [products]);

  const body = ((): React.ReactNode => {
    if (products.kind === 'failed')
      return (
        <div className="shop-empty" role="alert">
          <Icon name="info" />
          <h2>{t('products-failed')}</h2>
          <p>{t('products-failed-body')}</p>
          {/* A plain link: a full request, so the read really runs again. */}
          <a className="btn ghost" href={href(shop, products.page)}>
            {t('try-again')}
          </a>
        </div>
      );
    const { items, page, hasMore } = products;
    if (items.length === 0 && page === 1)
      return (
        <div className="shop-empty">
          <Icon name="store" />
          <h2>{t('no-products')}</h2>
          <p>{t('no-products-body', { name: shop.name })}</p>
        </div>
      );
    if (items.length === 0)
      return (
        <div className="shop-empty">
          <Icon name="search" />
          <h2>{t('page-empty')}</h2>
          <Link className="btn ghost" href={href(shop, 1)}>
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
        {page > 1 || hasMore ? (
          <nav className="pager nums shop-pager" aria-label={t('page-nav')}>
            {page > 1 ? (
              <Link href={href(shop, page - 1)} rel="prev" aria-label={t('previous-page')}>
                <Icon name="chevl" />
              </Link>
            ) : (
              <span aria-disabled="true" aria-label={t('previous-page')} role="link">
                <Icon name="chevl" />
              </span>
            )}
            <Link
              href={href(shop, page)}
              className="num"
              aria-current="page"
              aria-label={t('page-number', { page })}
            >
              {page}
            </Link>
            {hasMore ? (
              <Link href={href(shop, page + 1)} rel="next" aria-label={t('next-page')}>
                <Icon name="chevr" />
              </Link>
            ) : (
              <span aria-disabled="true" aria-label={t('next-page')} role="link">
                <Icon name="chevr" />
              </span>
            )}
          </nav>
        ) : null}
      </>
    );
  })();

  return (
    <div id={PRODUCTS_ANCHOR} ref={target} tabIndex={-1} className="shop-products-target">
      {body}
    </div>
  );
}
