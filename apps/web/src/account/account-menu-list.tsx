'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import { ACCOUNT_NAV, useLogOut } from './account-nav.ts';
import { useAccount } from './account-state.tsx';

/**
 * The account home as a menu list on the phone and tablet layout (below 900px, where the CSS
 * hides the quick tiles instead): one row per section with its count where the tiles show one,
 * then Log out. At 900px and wider the CSS hides this list and the tiles show.
 */
export function AccountMenuList() {
  const t = useTranslations('account');
  const logOut = useLogOut();
  const { addresses, lists } = useAccount();
  const { saved } = useStore();
  const secondary: Partial<Record<(typeof ACCOUNT_NAV)[number]['key'], string>> = {
    addresses: t('overview.addresses-count', { count: addresses.length }),
    lists: t('overview.lists-count', { count: saved.length + lists.length }),
    settings: t('overview.settings-body'),
  };
  return (
    <nav className="ac-menu" aria-label={t('menu')}>
      {ACCOUNT_NAV.filter((item) => item.key !== 'overview').map((item) => (
        <Link key={item.key} href={item.href}>
          <Icon name={item.icon} />
          <span className="ac-menu-t">
            <b>{t(`nav.${item.key}`)}</b>
            {secondary[item.key] ? <small>{secondary[item.key]}</small> : null}
          </span>
          <Icon name="chevr" />
        </Link>
      ))}
      <button type="button" onClick={logOut}>
        <Icon name="out" />
        <span className="ac-menu-t">
          <b>{t('log-out')}</b>
        </span>
      </button>
    </nav>
  );
}
