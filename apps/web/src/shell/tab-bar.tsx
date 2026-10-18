'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { summarise } from '../cart/cart.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from './store-context.tsx';

/** The bottom bar of the phone and tablet layout: Home, Search, Browse, Cart, Account. */
export function TabBar() {
  const t = useTranslations('tabs');
  const path = usePathname();
  const { cart, browseOpen, setBrowseOpen, searchOpen, setSearchOpen } = useStore();
  const { count } = summarise(cart);
  const overlay = browseOpen || searchOpen;
  const on = (active: boolean) => (active ? 'on' : undefined);
  const page = (href: string) => !overlay && (href === '/' ? path === '/' : path.startsWith(href));

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
        className={on(searchOpen)}
        aria-haspopup="dialog"
        aria-expanded={searchOpen}
        onClick={() => {
          setBrowseOpen(false);
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
        className={browseOpen ? 'browse on' : 'browse'}
        aria-haspopup="dialog"
        aria-expanded={browseOpen}
        aria-controls="browse-panel"
        onClick={() => {
          setSearchOpen(false);
          setBrowseOpen(!browseOpen);
        }}
      >
        <span className="tic">
          <Icon name="grid" />
        </span>
        {t('browse')}
      </button>
      <Link
        href="/cart"
        className={on(page('/cart'))}
        aria-current={page('/cart') ? 'page' : undefined}
      >
        <span className="tic cn">
          <Icon name="bag" />
          <span className="cb num" aria-hidden="true">
            {count}
          </span>
        </span>
        {t('cart')}
        <span className="sr-only">{t('cart-count', { count })}</span>
      </Link>
      <Link
        href="/account"
        className={on(page('/account'))}
        aria-current={page('/account') ? 'page' : undefined}
      >
        <span className="tic">
          <Icon name="user" />
        </span>
        {t('account')}
      </Link>
    </nav>
  );
}
