'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { summarise } from '../cart/cart.ts';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import type { DeliveryArea } from '../storefront/types.ts';
import { Logo } from './logo.tsx';
import { useStore } from './store-context.tsx';

export function Header({ delivery }: { readonly delivery: DeliveryArea }) {
  const t = useTranslations('header');
  const name = useTranslations('store')('name');
  const locale = useLocale();
  const { cart } = useStore();
  const { count, total } = summarise(cart);
  const totalText = total ? formatMoney(total, locale) : '';
  const ref = useRef<HTMLElement>(null);

  // The header's height drives the sticky offset of the side rail.
  useEffect(() => {
    const header = ref.current;
    if (!header || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const set = () => root.style.setProperty('--sf-header-height', `${header.offsetHeight}px`);
    set();
    const observer = new ResizeObserver(set);
    observer.observe(header);
    return () => observer.disconnect();
  }, []);

  return (
    <header className="top" ref={ref}>
      <div className="top-in">
        <div className="lead">
          <Logo name={name} href="/" />
        </div>
        <form className="search" role="search" action="/search">
          <Icon name="search" />
          <input
            type="search"
            name="q"
            aria-label={t('search')}
            placeholder={t('search-placeholder')}
          />
          <button className="go" type="submit" aria-label={t('search')}>
            <Icon name="search" />
          </button>
        </form>
        <div className="acts">
          <button
            className="deliver"
            type="button"
            aria-label={t('change-area', { area: delivery.label })}
          >
            <Icon name="pin" />
            <span className="dt">
              <small>{t('deliver-to')}</small>
              <b>{delivery.label}</b>
            </span>
            <span className="dc">
              <Icon name="chevd" />
            </span>
          </button>
          <Link className="login" href="/account" aria-label={t('log-in')}>
            <Icon name="user" />
            <span className="lt">{t('log-in')}</span>
          </Link>
          <Link
            className="cartpill"
            href="/cart"
            aria-label={t('cart', { count, total: totalText })}
          >
            <span className="cn">
              <Icon name="bag" />
              <span className="cb num" aria-hidden="true">
                {count}
              </span>
            </span>
            <span className="ct num" aria-hidden="true">
              {total ? totalText : formatMoney({ amount: 0, currency: currencyOf(cart) }, locale)}
            </span>
          </Link>
        </div>
      </div>
    </header>
  );
}

function currencyOf(cart: ReturnType<typeof useStore>['cart']): string {
  return Object.values(cart)[0]?.unitPrice.currency ?? 'AUD';
}
