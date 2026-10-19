'use client';

import { useTranslations } from 'next-intl';
import { lineLimit } from '../cart/cart.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { ProductOffer } from '../storefront/types.ts';

/**
 * Add to cart for one offer; after the first add it becomes a - n + stepper capped by the units
 * left. `wide` fills the buy box and notes "In your cart"; `bar` is the sticky buy bar's compact
 * form and `small` the button of an Other sellers row.
 */
export function BuyControl({
  offer,
  variant,
}: {
  readonly offer: ProductOffer;
  readonly variant: 'wide' | 'bar' | 'small';
}) {
  const t = useTranslations('product');
  const { cart, add, remove } = useStore();
  const quantity = cart[offer.id]?.quantity ?? 0;
  const limit = lineLimit(offer.lowStock);
  if (limit === 0)
    return (
      <button className={`btn ${variant}`} type="button" disabled>
        {t('out-of-stock')}
      </button>
    );
  if (quantity === 0)
    return (
      <button
        className={`btn ${variant}`}
        type="button"
        {...(variant === 'small'
          ? { 'aria-label': t('add-offer', { seller: offer.seller.name }) }
          : {})}
        onClick={() => add(offer.id, offer.price, limit)}
      >
        {variant === 'small' ? null : <Icon name="bag" />}
        {t('add-to-cart')}
      </button>
    );
  const full = quantity >= limit;
  return (
    <div className={`qrow ${variant}`}>
      <div className="qstep" role="group" aria-label={t('quantity')}>
        <button type="button" aria-label={t('decrease')} onClick={() => remove(offer.id)}>
          <Icon name="minus" />
        </button>
        <output className="num" aria-live="polite">
          {quantity}
        </output>
        <button
          type="button"
          aria-label={t('increase')}
          disabled={full}
          onClick={() => add(offer.id, offer.price, limit)}
        >
          <Icon name="plus" />
        </button>
      </div>
      {variant === 'wide' ? (
        <span className="incart">{full ? t('in-cart-max') : t('in-cart')}</span>
      ) : null}
    </div>
  );
}
