'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useMemo, type ReactNode } from 'react';
import { formatDate } from '../format/date.ts';
import { Icon, categoryIcon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { AccountSource, OrderPartStatus, OrderStatus } from '../storefront/types.ts';
import { AccountProvider } from './account-state.tsx';
import { AuthForms } from './auth-forms.tsx';

/**
 * The signed-in account pages: signed out, the log-in page shows in their place (any account
 * address); signed in, the pages share the account state. Live, the session is the API's; sample mode keeps a sample session.
 */
export function AccountArea({
  source,
  children,
}: {
  readonly source: AccountSource;
  readonly children: ReactNode;
}) {
  const { customer, setCustomer, sessionReady, signIn } = useStore();
  // Live: the signed-in customer is the API's; the sample orders, lists and emails stay as they are.
  const effective = useMemo(
    () => (source.live && customer ? { ...source, customer, mobile: '' } : source),
    [source, customer],
  );
  // The session is still being read: show neither the log-in page nor the account.
  if (!sessionReady) return null;
  if (!customer)
    return (
      <div className="ac">
        <section className="ac-card ac-auth">
          <AuthForms
            heading={(title) => <h1 className="ac-ah">{title}</h1>}
            {...(source.live ? { signIn } : {})}
            onSignedIn={() => {
              if (!source.live) setCustomer(source.customer);
            }}
          />
        </section>
      </div>
    );
  return <AccountProvider source={effective}>{children}</AccountProvider>;
}

/** Where the phone and tablet back link of an account page goes; the overview has none. */
export function backTarget(path: string): AccountBack | null {
  // An order's page has its own back link to Orders.
  if (/^\/account\/orders\/[^/]+/.test(path)) return null;
  if (/^\/account\/(orders|addresses|lists|settings)(\/|$)/.test(path))
    return { href: '/account', key: 'account' };
  return null;
}

export interface AccountBack {
  readonly href: string;
  readonly key: 'account' | 'settings';
}

/**
 * An account page: its h1 and a single column of cards, full width of the content area. Below
 * 900px a back link sits above the h1 (CSS hides it at 900px and wider): `back` overrides the
 * target taken from the address, null leaves it out.
 */
export function AccountFrame({
  title,
  back,
  children,
}: {
  readonly title: string;
  readonly back?: AccountBack | null;
  readonly children: ReactNode;
}) {
  const t = useTranslations('account.back');
  const path = usePathname();
  const target = back === undefined ? backTarget(path) : back;
  return (
    <div className="ac">
      {target ? (
        <Link className="ac-back" href={target.href} aria-label={t('aria', { to: t(target.key) })}>
          <Icon name="chevl" />
          {t(target.key)}
        </Link>
      ) : null}
      <h1>{title}</h1>
      <div className="ac-main">{children}</div>
    </div>
  );
}

const ORDER_TONE: Record<OrderStatus, string> = {
  'in-progress': 'go',
  delivered: 'ok',
  cancelled: 'no',
};
const PART_TONE: Record<OrderPartStatus, string> = {
  waiting: 'wait',
  confirmed: 'go',
  'out-for-delivery': 'go',
  delivered: 'ok',
  cancelled: 'no',
};

export function OrderBadge({ status }: { readonly status: OrderStatus }) {
  const t = useTranslations('account.status');
  return <span className={`ac-badge ${ORDER_TONE[status]}`}>{t(status)}</span>;
}

export function PartBadge({ status }: { readonly status: OrderPartStatus }) {
  const t = useTranslations('account.part-status');
  return <span className={`ac-badge ${PART_TONE[status]}`}>{t(status)}</span>;
}

/** A product picture of a list or order line, or its category icon. Decorative. */
export function LineThumb({
  imageUrl,
  category,
}: {
  readonly imageUrl?: string | undefined;
  readonly category: string;
}) {
  return (
    <span className="cim" aria-hidden="true">
      {imageUrl ? (
        <img src={imageUrl} alt="" loading="lazy" decoding="async" />
      ) : (
        <Icon name={categoryIcon(category)} />
      )}
    </span>
  );
}

/** Formats an ISO date of the account pages ("19 Oct 2026", or "13 Oct" without the year). */
export function useDay(): (iso: string, withYear?: boolean) => string {
  const locale = useLocale();
  return (iso, withYear = true) =>
    formatDate(iso, locale, {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
    });
}

/** The "nothing here yet" box of a page. */
export function AccountEmpty({
  icon,
  title,
  children,
}: {
  readonly icon: 'bag' | 'search' | 'pin';
  readonly title: string;
  readonly children?: ReactNode;
}) {
  return (
    <section className="ac-empty">
      <Icon name={icon} />
      <h2>{title}</h2>
      {children}
    </section>
  );
}
