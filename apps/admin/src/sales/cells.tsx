'use client';

import { useLocale, useTranslations } from 'next-intl';
import type { ReactNode } from 'react';
import { FallbackId } from '../orders/fallback-id.tsx';
import type { Money } from '../orders/types.ts';
import { formatMoney } from '../pricing/format.ts';
import { shortInstantInZone } from '../shared/format.ts';
import { shortId } from '../shared/short-id.ts';

/** A value that is missing, said in words and muted: never a bare dash (spec 0.7). */
export function EmptyWord({ children }: { readonly children: ReactNode }) {
  return <span className="text-fg-muted">{children}</span>;
}

/** "Order 654165CC", linking to the order; the full id is the tooltip. */
export function OrderLink({
  orderId,
  href,
}: {
  readonly orderId: string;
  /** Where the link goes; the order page by default. */
  readonly href?: string;
}) {
  const t = useTranslations('orders');
  return (
    <a
      className="font-medium text-link underline lg:whitespace-nowrap"
      href={href ?? `/orders/${encodeURIComponent(orderId)}`}
      title={orderId}
    >
      {t('reference', { id: shortId(orderId) })}
    </a>
  );
}

/** The store name (seller text, shown as text), else the short id of the seller. */
export function StoreCell({
  storeName,
  sellerId,
}: {
  readonly storeName: string | null;
  readonly sellerId: string;
}) {
  const name = storeName?.trim() ?? '';
  return name === '' ? (
    <FallbackId id={sellerId} />
  ) : (
    <span className="min-w-0 [overflow-wrap:anywhere]" title={name}>
      {name}
    </span>
  );
}

/** An id as a short muted value, the full id in the tooltip. */
export function ShortIdCell({ id }: { readonly id: string }) {
  return <FallbackId id={id} />;
}

/** An instant in the list's zone, or the page's word for none (muted). */
export function TimeCell({
  at,
  zone,
  empty,
}: {
  readonly at: string | null;
  readonly zone: string;
  /** What shows when there is no instant ("Not yet"); without it the cell shows nothing. */
  readonly empty?: string;
}) {
  const locale = useLocale();
  if (at === null) return empty === undefined ? null : <EmptyWord>{empty}</EmptyWord>;
  return <span className="whitespace-nowrap">{shortInstantInZone(at, locale, zone, true)}</span>;
}

const isZero = (money: Money) => /^0+$/.test(money.amount);

/**
 * Money in the amount's own currency (never an assumed one), as the Market's locale writes it.
 * `strong` is the main amount of a row; `zeroWord` shows in place of a zero amount.
 */
export function MoneyCell({
  money,
  strong = false,
  zeroWord,
}: {
  readonly money: Money;
  readonly strong?: boolean;
  readonly zeroWord?: string;
}) {
  const locale = useLocale();
  if (zeroWord !== undefined && isZero(money)) return <EmptyWord>{zeroWord}</EmptyWord>;
  return (
    <span className={`tabular-nums ${strong ? 'font-medium' : ''}`}>
      {formatMoney(money, locale)}
    </span>
  );
}
