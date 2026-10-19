'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '../icons/icon.tsx';
import type { IconName } from '../icons/icon-paths.tsx';
import { ACCOUNT_NAV, useAccountCurrent, useLogOut } from '../account/account-nav.ts';
import { useStore } from './store-context.tsx';

interface RailLink {
  readonly href: string;
  readonly icon: IconName;
  readonly label: 'home' | 'offers' | 'express' | 'sellers' | 'recipes' | 'gift-cards' | 'sell';
}

const SHOP: readonly RailLink[] = [
  { href: '/', icon: 'home', label: 'home' },
  { href: '/offers', icon: 'tag', label: 'offers' },
  { href: '/express', icon: 'bolt', label: 'express' },
  { href: '/sellers', icon: 'store', label: 'sellers' },
];
const MORE: readonly RailLink[] = [
  { href: '/recipes', icon: 'book', label: 'recipes' },
  { href: '/gift-cards', icon: 'gift', label: 'gift-cards' },
  { href: '/sell', icon: 'store', label: 'sell' },
];

/** The fixed side menu of the desktop layout (from 900px). */
export function Rail() {
  const t = useTranslations('rail');
  const path = usePathname();
  const { browseOpen, setBrowseOpen } = useStore();
  const [more, setMore] = useState(false);
  const item = (link: RailLink) => (
    <Link
      key={link.href}
      href={link.href}
      className={path === link.href ? 'cur' : undefined}
      aria-current={path === link.href ? 'page' : undefined}
    >
      <Icon name={link.icon} />
      {t(link.label)}
      {link.label === 'express' ? <span className="tagx">{t('same-day')}</span> : null}
    </Link>
  );
  return (
    <nav className="rail" aria-label={t('label')}>
      <button
        type="button"
        id="browse"
        className={browseOpen || path.startsWith('/c/') ? 'cta on' : 'cta'}
        aria-haspopup="dialog"
        aria-expanded={browseOpen}
        aria-controls="browse-panel"
        onClick={() => setBrowseOpen(!browseOpen)}
      >
        <Icon name="grid" />
        {t('browse')}
        <span className="rt">
          <Icon name="chevr" />
        </span>
      </button>
      {SHOP.map(item)}
      <div id="rail-more" hidden={!more}>
        {MORE.map(item)}
      </div>
      <button
        type="button"
        aria-expanded={more}
        aria-controls="rail-more"
        onClick={() => setMore(!more)}
      >
        <Icon name="chevd" />
        {more ? t('show-less') : t('show-more')}
      </button>
      <hr />
      <RailAccount />
    </nav>
  );
}

/**
 * The account part of the rail, the only account navigation on the desktop layout. Signed out:
 * one "My Account" row that opens the log-in dialog. Signed in: the "My Account" heading with
 * the ringed avatar, the account pages and Log out.
 */
function RailAccount() {
  const t = useTranslations('account');
  const { customer, setLoginOpen } = useStore();
  const current = useAccountCurrent();
  const logOut = useLogOut();
  if (!customer)
    return (
      <button type="button" aria-haspopup="dialog" onClick={() => setLoginOpen(true)}>
        <Icon name="user" />
        {t('my-account')}
      </button>
    );
  return (
    <>
      <h3 className="rah">
        <span className="rau in" aria-hidden="true">
          <Icon name="user" />
        </span>
        <span>
          {t('my-account')}
          <span className="sr-only"> ({t('signed-in-as', { name: customer.fullName })})</span>
        </span>
      </h3>
      {ACCOUNT_NAV.map((link) => (
        <Link
          key={link.key}
          href={link.href}
          className={current === link.href ? 'cur' : undefined}
          aria-current={current === link.href ? 'page' : undefined}
        >
          <Icon name={link.icon} />
          {t(`nav.${link.key}`)}
        </Link>
      ))}
      <button type="button" className="rout" onClick={logOut}>
        <Icon name="out" />
        {t('log-out')}
      </button>
    </>
  );
}
