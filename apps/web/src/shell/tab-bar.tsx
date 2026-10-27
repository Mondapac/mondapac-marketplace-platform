'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { summarise } from '../cart/cart.ts';
import { Icon } from '../icons/icon.tsx';
import { useCartButton } from './header.tsx';
import { useCheckoutFocus } from './checkout-focus.tsx';
import { useStore } from './store-context.tsx';

/**
 * The bottom bar of the phone and tablet layout: Home, Search, Browse, Cart, Account. Account opens
 * the log-in dialog signed out and the account menu panel signed in (a green dot shows it).
 */
export function TabBar() {
  const t = useTranslations('tabs');
  const focus = useCheckoutFocus();
  const path = usePathname();
  const {
    cart,
    browseOpen,
    setBrowseOpen,
    searchOpen,
    setSearchOpen,
    cartOpen,
    setCartOpen,
    customer,
    loginOpen,
    setLoginOpen,
    accountOpen,
    setAccountOpen,
  } = useStore();
  const { count } = summarise(cart);
  const cartButton = useCartButton();
  const overlay = browseOpen || searchOpen || cartOpen || loginOpen || accountOpen;
  const on = (active: boolean) => (active ? 'on' : undefined);
  const page = (href: string) => !overlay && (href === '/' ? path === '/' : path.startsWith(href));
  const account = accountOpen || loginOpen || page('/account');
  // Checkout focus mode: nothing in the way of Pay.
  if (focus) return null;

  return (
    <nav className="tabbar" aria-label={t('label')}>
      <Link href="/" className={on(page('/'))} aria-current={page('/') ? 'page' : undefined}>
        <span className="tic">
          <Icon name="home" />
        </span>
        {t('home')}
      </Link>
      <button
        type="button"
        className={on(searchOpen || page('/search'))}
        aria-haspopup="dialog"
        aria-expanded={searchOpen}
        onClick={() => {
          setBrowseOpen(false);
          setCartOpen(false);
          setSearchOpen(true);
        }}
      >
        <span className="tic">
          <Icon name="search" />
        </span>
        {t('search')}
      </button>
      <button
        type="button"
        className={browseOpen || page('/c/') ? 'browse on' : 'browse'}
        aria-haspopup="dialog"
        aria-expanded={browseOpen}
        aria-controls="browse-panel"
        onClick={() => {
          setSearchOpen(false);
          setCartOpen(false);
          setBrowseOpen(!browseOpen);
        }}
      >
        <span className="tic">
          <Icon name="grid" />
        </span>
        {t('browse')}
      </button>
      <button type="button" className={on(cartOpen || page('/cart'))} {...cartButton}>
        <span className="tic cn">
          <Icon name="bag" />
          <span className="cb num" aria-hidden="true">
            {count}
          </span>
        </span>
        {t('cart')}
        <span className="sr-only">{t('cart-count', { count })}</span>
      </button>
      <button
        type="button"
        className={account ? 'acct on' : 'acct'}
        aria-haspopup="dialog"
        aria-expanded={customer ? accountOpen : loginOpen}
        aria-current={page('/account') ? 'page' : undefined}
        onClick={() => {
          setBrowseOpen(false);
          setSearchOpen(false);
          setCartOpen(false);
          if (customer) setAccountOpen(true);
          else setLoginOpen(true);
        }}
      >
        <span className="tic">
          <Icon name="user" />
          {customer ? <span className="tdot" aria-hidden="true" /> : null}
        </span>
        {t('account')}
        {customer ? <span className="sr-only">, {t('signed-in')}</span> : null}
      </button>
    </nav>
  );
}
