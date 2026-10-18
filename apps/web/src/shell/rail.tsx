'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Icon } from '../icons/icon.tsx';
import type { IconName } from '../icons/icon-paths.tsx';
import { useStore } from './store-context.tsx';

interface RailLink {
  readonly href: string;
  readonly icon: IconName;
  readonly label:
    | 'home'
    | 'offers'
    | 'express'
    | 'sellers'
    | 'recipes'
    | 'gift-cards'
    | 'sell'
    | 'orders'
    | 'saved'
    | 'account';
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
const YOU: readonly RailLink[] = [
  { href: '/account/orders', icon: 'bag', label: 'orders' },
  { href: '/account/lists', icon: 'heart', label: 'saved' },
  { href: '/account', icon: 'user', label: 'account' },
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
        className={browseOpen ? 'cta on' : 'cta'}
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
      <h3>{t('you')}</h3>
      {YOU.map(item)}
    </nav>
  );
}
