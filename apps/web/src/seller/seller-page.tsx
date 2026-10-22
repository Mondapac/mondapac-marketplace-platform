'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { SellerShop } from '../storefront/types.ts';
import { AboutPane, CertificatesPane } from './seller-panes.tsx';
import { ProductsPane } from './seller-products.tsx';
import { StoreProductsPane } from './store-products-pane.tsx';
import { SellerHead } from './seller-head.tsx';

// The seller page (approved design v9, `/s/<slug>`): the header card, then the Products, About
// and Certificates tabs. No breadcrumb on this page (john).

const ALL_TABS = ['products', 'about', 'certificates'] as const;
type Tab = (typeof ALL_TABS)[number];

export function SellerPage({
  shop,
  ratingsShown,
}: {
  readonly shop: SellerShop;
  readonly ratingsShown: boolean;
}) {
  const t = useTranslations('seller');
  // A part the seller read does not know yet has no tab (never "no products" or "no certificates").
  const { products, storeProducts, certificates } = shop;
  const tabs = ALL_TABS.filter(
    (key) =>
      (key !== 'products' || products !== undefined || storeProducts !== undefined) &&
      (key !== 'certificates' || certificates !== undefined),
  );
  const [tab, setTab] = useState<Tab>(tabs[0] ?? 'about');
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const label = (key: Tab) =>
    key === 'products'
      ? products === undefined
        ? t('products-tab-plain')
        : t('products-tab', { count: products.length })
      : t(key === 'about' ? 'about-tab' : 'certificates-tab');

  // Arrow keys, Home and End move between the tabs and select them (automatic activation).
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = tabs.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? (at + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(tabs[next]!);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  const pane =
    tab === 'products' && products !== undefined ? (
      <ProductsPane shop={{ ...shop, products, categories: shop.categories ?? [] }} />
    ) : tab === 'products' && storeProducts !== undefined ? (
      <StoreProductsPane shop={shop} products={storeProducts} />
    ) : tab === 'certificates' && certificates !== undefined ? (
      <CertificatesPane shop={shop} certificates={certificates} />
    ) : (
      <AboutPane shop={shop} />
    );

  return (
    <div className="shop">
      <SellerHead shop={shop} ratingsShown={ratingsShown} />
      {tabs.length === 1 ? (
        // One part known: a heading, not a tab bar with a single tab.
        <section className="shop-panel" aria-labelledby={`${id}-${tab}`}>
          <h2 className="shop-sec" id={`${id}-${tab}`}>
            {label(tab)}
          </h2>
          {pane}
        </section>
      ) : (
        <>
          <div
            className="shop-tabs"
            role="tablist"
            aria-label={t('sections')}
            ref={list}
            onKeyDown={onKey}
          >
            {tabs.map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                id={`${id}-${key}`}
                aria-selected={tab === key}
                aria-controls={`${id}-panel`}
                tabIndex={tab === key ? 0 : -1}
                onClick={() => setTab(key)}
              >
                {label(key)}
              </button>
            ))}
          </div>
          <div
            className="shop-panel"
            role="tabpanel"
            id={`${id}-panel`}
            aria-labelledby={`${id}-${tab}`}
            tabIndex={0}
          >
            {pane}
          </div>
        </>
      )}
    </div>
  );
}

/** The seller page while it loads: the header card, the tabs and a row of cards. */
export function SellerLoading({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-label={label} className="loading">
      <div className="skel shop-skel-head" aria-hidden="true" />
      <div className="skel line" aria-hidden="true" />
      <div className="shop-grid" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="skel card" />
        ))}
      </div>
    </div>
  );
}
