'use client';

import { useTranslations } from 'next-intl';
import { lineLimit } from '../cart/cart.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { ProductCard } from '../storefront/types.ts';

/** The round add button on a product tile; after the first add it becomes a - n + stepper. */
export function AddControl({ product }: { readonly product: ProductCard }) {
  const t = useTranslations('home');
  const { cart, add, remove } = useStore();
  const quantity = cart[product.id]?.quantity ?? 0;
  const limit = lineLimit(product.lowStock);
  if (limit === 0) return null;
  if (quantity === 0) {
    return (
      <button
        className="addb one"
        type="button"
        aria-label={t('add', { name: product.name })}
        onClick={() => add(product.id, product.price, limit)}
      >
        <Icon name="plus" />
      </button>
    );
  }
  const full = quantity >= limit;
  return (
    <div className="addb step" role="group" aria-label={t('quantity', { name: product.name })}>
      <button type="button" aria-label={t('decrease')} onClick={() => remove(product.id)}>
        <Icon name="minus" />
      </button>
      <output className="num" aria-live="polite">
        {quantity}
      </output>
      <button
        type="button"
        aria-label={full ? t('max-reached') : t('increase')}
        disabled={full}
        onClick={() => add(product.id, product.price, limit)}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
