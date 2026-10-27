'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon } from '../icons/icon.tsx';
import { Logo } from './logo.tsx';

/**
 * Checkout "focus mode" (phone and tablet, below 900px): on the checkout and payment pages the
 * bottom tab bar and the big footer go away and a simple header takes the place of the full one,
 * so nothing leads the buyer off the way to Pay. The confirmation and not-completed pages are not
 * in focus mode: the order is done (or nothing was charged) and the buyer needs the whole store
 * again. From 900px the pages keep the full header and footer.
 */
const FOCUS_PATHS: ReadonlySet<string> = new Set(['/checkout', '/checkout/payment']);

export function isCheckoutFocusPath(path: string | null | undefined): boolean {
  if (!path) return false;
  const bare = path.length > 1 ? path.replace(/\/+$/, '') : path;
  return FOCUS_PATHS.has(bare);
}

/** Whether the current page is in checkout focus mode. */
export function useCheckoutFocus(): boolean {
  return isCheckoutFocusPath(usePathname());
}

/** The focus-mode header: logo, a "Secure checkout" lock label and a link back to the cart. Hidden from 900px by CSS. */
export function FocusHeader() {
  const focus = useCheckoutFocus();
  const t = useTranslations('checkout');
  const name = useTranslations('store')('name');
  if (!focus) return null;
  return (
    <header className="cfh">
      <div className="cfh-in">
        <Link className="cfh-back" href="/cart" aria-label={t('focus-back')}>
          <Icon name="chevl" />
          <span className="short">{t('focus-back-short')}</span>
          <span className="long">{t('focus-back')}</span>
        </Link>
        <Logo name={name} href="/" />
        <span className="cfh-secure">
          <Icon name="lock" />
          <span className="short">{t('focus-secure-short')}</span>
          <span className="long">{t('focus-secure')}</span>
        </span>
      </div>
    </header>
  );
}
