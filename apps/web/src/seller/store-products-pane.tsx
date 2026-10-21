import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ProductCard } from '../home/product-card.tsx';
import { Icon } from '../icons/icon.tsx';
import type { SellerShop, StoreProducts } from '../storefront/types.ts';

// The Products tab of a real store: one page of the store's cards from the API, in name order,
// with Previous and Next links (the page number is in the URL, so a page can be shared and the
// back button works). No search box, sort or category chips: the API lists by name and gives no
// total, so those would act on one page only and mislead. A failed read is said inside the tab.

const href = (shop: SellerShop, page: number): string =>
  page === 1 ? `/s/${shop.id}` : `/s/${shop.id}?page=${page}`;

export function StoreProductsPane({
  shop,
  products,
}: {
  readonly shop: SellerShop;
  readonly products: StoreProducts;
}) {
  const t = useTranslations('seller');
  if (products.kind === 'failed')
    return (
      <div className="shop-empty" role="alert">
        <Icon name="info" />
        <h2>{t('products-failed')}</h2>
        <p>{t('products-failed-body')}</p>
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
        <nav className="shop-pager" aria-label={t('page-nav')}>
          {page > 1 ? (
            <Link className="btn ghost" href={href(shop, page - 1)} rel="prev">
              {t('previous-page')}
            </Link>
          ) : null}
          <span className="num" aria-current="page">
            {t('page-number', { page })}
          </span>
          {hasMore ? (
            <Link className="btn ghost" href={href(shop, page + 1)} rel="next">
              {t('next-page')}
            </Link>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}
