'use client';

import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';
import { useLogOut } from '../account/account-nav.ts';
import { summarise } from '../cart/cart.ts';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { useSearchSubmit } from '../search/search-focus.tsx';
import type { DeliveryArea } from '../storefront/types.ts';
import { Logo } from './logo.tsx';
import { useStore } from './store-context.tsx';

export function Header({ delivery }: { readonly delivery: DeliveryArea }) {
  const t = useTranslations('header');
  const name = useTranslations('store')('name');
  const locale = useLocale();
  const { cart, customer, setLoginOpen } = useStore();
  const logOut = useLogOut();
  const cartButton = useCartButton();
  const { count, total } = summarise(cart);
  const totalText = total ? formatMoney(total, locale) : '';
  const ref = useRef<HTMLElement>(null);
  // On the results page the box keeps the words searched for.
  const searched = useSearchParams()?.get('q') ?? '';
  const query = usePathname() === '/search' ? searched : '';
  const onSearch = useSearchSubmit();

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
        <form className="search" role="search" action="/search" onSubmit={onSearch}>
          <Icon name="search" />
          <input
            key={query}
            type="search"
            name="q"
            defaultValue={query}
            aria-label={t('search')}
            placeholder={t('search-placeholder')}
            maxLength={100}
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
          {customer ? (
            <button className="login" type="button" aria-label={t('log-out')} onClick={logOut}>
              <Icon name="out" />
              <span className="lt">{t('log-out')}</span>
            </button>
          ) : (
            <button
              className="login"
              type="button"
              aria-label={t('log-in')}
              aria-haspopup="dialog"
              onClick={() => setLoginOpen(true)}
            >
              <Icon name="user" />
              <span className="lt">{t('log-in')}</span>
            </button>
          )}
          <button
            className="cartpill"
            type="button"
            aria-label={t('cart', { count, total: totalText })}
            {...cartButton}
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
          </button>
        </div>
      </div>
    </header>
  );
}

/**
 * The props of a cart button (header pill, Cart tab): it opens the cart drawer, and does nothing
 * on the cart page itself.
 */
export function useCartButton() {
  const { cartOpen, setCartOpen, setBrowseOpen, setSearchOpen } = useStore();
  const onCartPage = usePathname() === '/cart';
  if (onCartPage) return { 'aria-current': 'page' as const };
  return {
    'aria-haspopup': 'dialog' as const,
    'aria-expanded': cartOpen,
    'aria-controls': 'cart-drawer',
    onClick: () => {
      setBrowseOpen(false);
      setSearchOpen(false);
      setCartOpen(!cartOpen);
    },
  };
}

function currencyOf(cart: ReturnType<typeof useStore>['cart']): string {
  return Object.values(cart)[0]?.unitPrice.currency ?? 'AUD';
}
