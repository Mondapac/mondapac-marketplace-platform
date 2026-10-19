'use client';

import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '../format/money.ts';
import { Icon, categoryIcon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { CartItem } from '../storefront/types.ts';
import type { CartGroupLine, CartView } from './cart.ts';

// Pieces the cart drawer, the cart page and checkout share.

/** A line's photo, or its category icon when there is none. */
export function ItemThumb({ item }: { readonly item: CartItem }) {
  return (
    <span className="cim" aria-hidden="true">
      {item.imageUrl ? (
        <img src={item.imageUrl} alt="" loading="lazy" decoding="async" />
      ) : (
        <Icon name={categoryIcon(item.category)} />
      )}
    </span>
  );
}

/** The - n + stepper of a cart line, capped by the line's limit; `small` is the drawer's. */
export function LineStepper({
  line,
  small = false,
}: {
  readonly line: CartGroupLine;
  readonly small?: boolean;
}) {
  const t = useTranslations('cart');
  const { add, remove } = useStore();
  return (
    <div
      className={small ? 'qs sm' : 'qs'}
      role="group"
      aria-label={t('quantity-for', { name: line.item.name })}
    >
      <button type="button" aria-label={t('decrease')} onClick={() => remove(line.id)}>
        <Icon name="minus" />
      </button>
      <output className="num" aria-live="polite">
        {line.quantity}
      </output>
      <button
        type="button"
        aria-label={t('increase')}
        disabled={line.quantity >= line.limit}
        onClick={() => add(line.id, line.item.price, line.limit)}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}

/** The Remove link of a cart line. */
export function RemoveLine({ line }: { readonly line: CartGroupLine }) {
  const t = useTranslations('cart');
  const { removeLine } = useStore();
  return (
    <button
      className="lnk"
      type="button"
      aria-label={t('remove-item', { name: line.item.name })}
      onClick={() => removeLine(line.id)}
    >
      {t('remove')}
    </button>
  );
}

/** Items, delivery and total, with the tax the total includes. */
export function SummaryTotals({ view }: { readonly view: CartView }) {
  const t = useTranslations('cart');
  const locale = useLocale();
  const money = (m: CartView['total']) => formatMoney(m, locale);
  return (
    <>
      <dl>
        <div>
          <dt>{t('summary-items', { count: view.count })}</dt>
          <dd className="num">{money(view.items)}</dd>
        </div>
        <div>
          <dt>{t('summary-delivery', { count: view.groups.length })}</dt>
          <dd className="num">{money(view.delivery)}</dd>
        </div>
        <div className="tot">
          <dt>{t('total')}</dt>
          <dd className="num">{money(view.total)}</dd>
        </div>
      </dl>
      <small>{t('includes-tax', { amount: money(view.includedTax) })}</small>
    </>
  );
}

/** The two reassurance lines under the summary. */
export function TrustLines() {
  const t = useTranslations('cart');
  return (
    <div className="ctr">
      <span>
        <Icon name="lock" />
        {t('trust-card')}
      </span>
      <span>
        <Icon name="truck" />
        {t('trust-split')}
      </span>
    </div>
  );
}

/** The DOM id of a seller's part on the cart page; the blocked-seller links scroll to it. */
export const groupAnchor = (sellerId: string) => `seller-${sellerId}`;
