'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import { ACCOUNT_NAV, useAccountCurrent, useLogOut } from './account-nav.ts';
import { useDialog } from './use-dialog.ts';
import { from } from '../shell/breakpoints.ts';

/**
 * The account menu of the phone and tablet layout (below 900px): a right slide-in panel opened by
 * the Account tab when signed in. Each item opens its own page; Esc and the scrim close it, Tab
 * stays inside, focus goes back to the tab. It closes on a new page and at the desktop layout.
 */
export function AccountDrawer() {
  const t = useTranslations('account');
  const path = usePathname();
  const { customer, accountOpen, setAccountOpen } = useStore();
  const open = accountOpen && customer !== null;
  const current = useAccountCurrent();
  const logOut = useLogOut();
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const close = () => setAccountOpen(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => setAccountOpen(false), [path, setAccountOpen]);
  useEffect(() => {
    if (!open || typeof window.matchMedia !== 'function') return;
    const desktop = window.matchMedia(from('desktop'));
    const onChange = () => {
      if (desktop.matches) setAccountOpen(false);
    };
    desktop.addEventListener('change', onChange);
    return () => desktop.removeEventListener('change', onChange);
  }, [open, setAccountOpen]);
  useDialog(
    open,
    close,
    panel,
    (root) =>
      root.querySelector<HTMLElement>('.adl [aria-current="page"]') ??
      root.querySelector<HTMLElement>('.adl a'),
  );

  if (!mounted) return null;
  return createPortal(
    <div className={open ? 'adw open' : 'adw'}>
      <div className="adscrim" onClick={close} />
      <aside
        className="adp"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="account-drawer-title"
        inert={!open}
      >
        <div className="adh">
          <span className="rau in" aria-hidden="true">
            <Icon name="user" />
          </span>
          <div className="adn">
            <h2 id="account-drawer-title">{t('my-account')}</h2>
            {customer ? <small>{t('signed-in-as', { name: customer.fullName })}</small> : null}
          </div>
          <button className="iconbtn" type="button" aria-label={t('close-menu')} onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <nav className="adl" aria-label={t('menu')}>
          {ACCOUNT_NAV.map((item) => (
            <Link
              key={item.key}
              href={item.href}
              aria-current={current === item.href ? 'page' : undefined}
              onClick={close}
            >
              <Icon name={item.icon} />
              {t(`nav.${item.key}`)}
            </Link>
          ))}
          <hr />
          <button type="button" onClick={logOut}>
            <Icon name="out" />
            {t('log-out')}
          </button>
        </nav>
      </aside>
    </div>,
    document.body,
  );
}
