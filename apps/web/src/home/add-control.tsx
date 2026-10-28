'use client';

import { useTranslations } from 'next-intl';
import { lineLimit } from '../cart/cart.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { ProductCard } from '../storefront/types.ts';

/** The round add button on a product tile; after the first add it becomes a - n + stepper. */
export function AddControl({ product }: { readonly product: ProductCard }) {
  const t = useTranslations('home');
  const { cart, add, remove, online, live } = useStore();
  const off = online ? undefined : true;
  const quantity = cart[product.id]?.quantity ?? 0;
  const limit = lineLimit(product.lowStock);
  // A real card names a product, not the Variant to buy: the buyer picks it on the product page.
  if (limit === 0 || live) return null;
  if (quantity === 0) {
    return (
      <button
        className="addb one ctl"
        type="button"
        aria-disabled={off}
        aria-label={t('add', { name: product.name })}
        onClick={() => add(product.id, product.price, limit)}
      >
        <Icon name="plus" />
      </button>
    );
  }
  const full = quantity >= limit;
  return (
    <div className="addb step ctl" role="group" aria-label={t('quantity', { name: product.name })}>
      <button
        type="button"
        aria-label={t('decrease')}
        aria-disabled={off}
        onClick={() => remove(product.id)}
      >
        <Icon name="minus" />
      </button>
      <output className="num" aria-live="polite">
        {quantity}
      </output>
      <button
        type="button"
        aria-label={full ? t('max-reached') : t('increase')}
        aria-disabled={off}
        disabled={full}
        onClick={() => add(product.id, product.price, limit)}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
