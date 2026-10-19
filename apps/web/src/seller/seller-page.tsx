'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, useState, type KeyboardEvent } from 'react';
import type { SellerShop } from '../storefront/types.ts';
import { AboutPane, CertificatesPane } from './seller-panes.tsx';
import { ProductsPane } from './seller-products.tsx';
import { SellerHead } from './seller-head.tsx';

// The seller page (approved design v9, `/s/<slug>`): the header card, then the Products, About
// and Certificates tabs. No breadcrumb on this page (john).

const TABS = ['products', 'about', 'certificates'] as const;
type Tab = (typeof TABS)[number];

export function SellerPage({
  shop,
  ratingsShown,
}: {
  readonly shop: SellerShop;
  readonly ratingsShown: boolean;
}) {
  const t = useTranslations('seller');
  const [tab, setTab] = useState<Tab>('products');
  const id = useId();
  const list = useRef<HTMLDivElement>(null);
  const label = (key: Tab) =>
    key === 'products'
      ? t('products-tab', { count: shop.products.length })
      : t(key === 'about' ? 'about-tab' : 'certificates-tab');

  // Arrow keys, Home and End move between the tabs and select them (automatic activation).
  const onKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const at = TABS.indexOf(tab);
    const next =
      event.key === 'ArrowRight'
        ? (at + 1) % TABS.length
        : event.key === 'ArrowLeft'
          ? (at - 1 + TABS.length) % TABS.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? TABS.length - 1
              : -1;
    if (next < 0) return;
    event.preventDefault();
    setTab(TABS[next]!);
    list.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div className="shop">
      <SellerHead shop={shop} ratingsShown={ratingsShown} />
      <div
        className="shop-tabs"
        role="tablist"
        aria-label={t('sections')}
        ref={list}
        onKeyDown={onKey}
      >
        {TABS.map((key) => (
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
        {tab === 'products' ? (
          <ProductsPane shop={shop} />
        ) : tab === 'about' ? (
          <AboutPane shop={shop} />
        ) : (
          <CertificatesPane shop={shop} />
        )}
      </div>
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
