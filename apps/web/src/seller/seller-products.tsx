'use client';

import { useTranslations } from 'next-intl';
import { useMemo, useRef, useState } from 'react';
import { ProductCard } from '../home/product-card.tsx';
import { Icon } from '../icons/icon.tsx';
import type { SellerProduct, SellerShop } from '../storefront/types.ts';

// The Products tab of the seller page: search in this shop, sort, category chips (from two
// categories), the count, the card grid and "Show more", which adds eight cards at a time.

const SORTS = ['popular', 'newest', 'price-low', 'price-high'] as const;
type Sort = (typeof SORTS)[number];
const SORT_LABELS = {
  popular: 'sort-popular',
  newest: 'sort-newest',
  'price-low': 'sort-price-low',
  'price-high': 'sort-price-high',
} as const;
const PAGE = 8;
const ALL = 'all';

function sorted(products: readonly SellerProduct[], sort: Sort): SellerProduct[] {
  const list = [...products];
  if (sort === 'newest') list.sort((a, b) => b.listedAt.localeCompare(a.listedAt));
  if (sort === 'price-low') list.sort((a, b) => a.price.amount - b.price.amount);
  if (sort === 'price-high') list.sort((a, b) => b.price.amount - a.price.amount);
  return list;
}

export function ProductsPane({
  shop,
}: {
  readonly shop: SellerShop & Required<Pick<SellerShop, 'products' | 'categories'>>;
}) {
  const t = useTranslations('seller');
  const [query, setQuery] = useState('');
  const [sort, setSort] = useState<Sort>('popular');
  const [category, setCategory] = useState(ALL);
  const [shown, setShown] = useState(PAGE);
  const search = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const words = query.trim().toLowerCase();
    return sorted(
      shop.products.filter(
        (p) =>
          (category === ALL || p.category === category) &&
          (!words || p.name.toLowerCase().includes(words)),
      ),
      sort,
    );
  }, [shop.products, query, category, sort]);

  if (shop.products.length === 0)
    return (
      <div className="shop-empty">
        <Icon name="store" />
        <h2>{t('no-products')}</h2>
        <p>{t('no-products-body', { name: shop.name })}</p>
      </div>
    );

  const clear = () => {
    setQuery('');
    setCategory(ALL);
    setShown(PAGE);
    search.current?.focus();
  };
  const rest = matches.length - Math.min(shown, matches.length);
  const chips = [{ code: ALL, name: t('all') }, ...shop.categories];

  return (
    <>
      <div className="shop-tools">
        <div className="shop-tools-row">
          <label className="shop-search">
            <Icon name="search" />
            <input
              type="search"
              ref={search}
              aria-label={t('search', { name: shop.name })}
              placeholder={t('search-placeholder')}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setShown(PAGE);
              }}
            />
          </label>
          <div className="shop-sort">
            <label htmlFor="shop-sort">{t('sort')}</label>
            <select
              id="shop-sort"
              value={sort}
              onChange={(event) => {
                setSort(event.target.value as Sort);
                setShown(PAGE);
              }}
            >
              {SORTS.map((s) => (
                <option key={s} value={s}>
                  {t(SORT_LABELS[s])}
                </option>
              ))}
            </select>
          </div>
        </div>
        {shop.categories.length >= 2 ? (
          <div className="shop-cats" role="group" aria-label={t('category')}>
            {chips.map((c) => (
              <button
                key={c.code}
                type="button"
                aria-pressed={category === c.code}
                onClick={() => {
                  setCategory(c.code);
                  setShown(PAGE);
                }}
              >
                {c.name}
              </button>
            ))}
          </div>
        ) : null}
        <p className="shop-count" role="status">
          {t('count', { count: matches.length })}
        </p>
      </div>
      {matches.length > 0 ? (
        <>
          <div className="shop-grid">
            {matches.slice(0, shown).map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
          {rest > 0 ? (
            <button
              className="btn ghost shop-more"
              type="button"
              onClick={() => setShown((n) => n + PAGE)}
            >
              {t('show-more', { count: rest })}
            </button>
          ) : null}
        </>
      ) : (
        <div className="shop-empty">
          <Icon name="search" />
          <h2>{t('no-match')}</h2>
          <p>{t('no-match-body')}</p>
          <button className="btn ghost" type="button" onClick={clear}>
            {t('clear-search')}
          </button>
        </div>
      )}
    </>
  );
}
