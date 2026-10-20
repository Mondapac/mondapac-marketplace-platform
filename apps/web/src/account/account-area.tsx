'use client';

import { useFormatter, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { Icon, categoryIcon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type {
  AccountSource,
  OrderPartStatus,
  OrderStatus,
  SignInProvider,
} from '../storefront/types.ts';
import { AccountProvider } from './account-state.tsx';
import { AuthForms } from './auth-forms.tsx';

/**
 * The signed-in account pages: signed out, the log-in page shows in their place (any account
 * address); signed in, the pages share the account state. Sample session until sessions are wired.
 */
export function AccountArea({
  source,
  providers,
  children,
}: {
  readonly source: AccountSource;
  /** The sign-in providers the Market offers (none: no provider button). */
  readonly providers: readonly SignInProvider[];
  readonly children: ReactNode;
}) {
  const { customer, setCustomer } = useStore();
  if (!customer)
    return (
      <div className="ac">
        <section className="ac-card ac-auth">
          <AuthForms
            providers={providers}
            heading={(title) => <h1 className="ac-ah">{title}</h1>}
            onSignedIn={() => setCustomer(source.customer)}
          />
        </section>
      </div>
    );
  return <AccountProvider source={source}>{children}</AccountProvider>;
}

/** An account page: its h1 and a single column of cards, full width of the content area. */
export function AccountFrame({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="ac">
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
  const format = useFormatter();
  return (iso, withYear = true) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      ...(withYear ? { year: 'numeric' } : {}),
      timeZone: 'UTC',
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
