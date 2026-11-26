'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef } from 'react';
import Link from 'next/link';
import { lineLimit } from '../cart/cart.ts';
import { unitKey } from '../cart/live-cart.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { ShelfCard } from '../storefront/types.ts';

/**
 * The round add button on a product tile; after the first add it becomes a - n + stepper. A real
 * (live) card carts its one sell unit; a card that names several (or none) links to the product
 * page, where the buyer picks the Variant.
 */
export function AddControl({
  product,
  href,
}: {
  readonly product: ShelfCard & { readonly price: NonNullable<ShelfCard['price']> };
  readonly href: string;
}) {
  const t = useTranslations('home');
  const { cart, add, remove, online, live } = useStore();
  const off = online ? undefined : true;
  const limit = lineLimit(product.lowStock);
  // A sample card is carted by its product id; a real one by its sell unit.
  const id = live && product.unit !== undefined ? unitKey(product.unit) : product.id;
  const quantity = cart[id]?.quantity ?? 0;
  // The pressed button is replaced by the other form (add <-> stepper): keep the keyboard focus
  // on the control that takes its place instead of letting it fall back to the page.
  const addRef = useRef<HTMLButtonElement>(null);
  const plusRef = useRef<HTMLButtonElement>(null);
  const minusRef = useRef<HTMLButtonElement>(null);
  const refocus = useRef<'add' | 'step' | null>(null);
  useEffect(() => {
    if (refocus.current === 'step') (plusRef.current ?? minusRef.current)?.focus();
    if (refocus.current === 'add') addRef.current?.focus();
    refocus.current = null;
  }, [quantity]);
  if (limit === 0) return null;
  const choose = product.priceFrom === true || (live && product.unit === undefined);
  if (choose) {
    return (
      <Link
        className="addb one ctl"
        href={href}
        aria-label={t('choose-options', { name: product.name })}
      >
        <Icon name="plus" />
      </Link>
    );
  }
  if (quantity === 0) {
    return (
      <button
        ref={addRef}
        className="addb one ctl"
        type="button"
        aria-disabled={off}
        aria-label={t('add', { name: product.name })}
        onClick={() => {
          refocus.current = 'step';
          add(id, product.price, limit);
        }}
      >
        <Icon name="plus" />
      </button>
    );
  }
  const full = quantity >= limit;
  return (
    <div className="addb step ctl" role="group" aria-label={t('quantity', { name: product.name })}>
      <button
        ref={minusRef}
        type="button"
        aria-label={t('decrease')}
        aria-disabled={off}
        onClick={() => {
          if (quantity === 1) refocus.current = 'add';
          remove(id);
        }}
      >
        <Icon name="minus" />
      </button>
      <output className="num" aria-live="polite">
        {quantity}
      </output>
      <button
        ref={plusRef}
        type="button"
        aria-label={full ? t('max-reached') : t('increase')}
        aria-disabled={off}
        disabled={full}
        onClick={() => add(id, product.price, limit)}
      >
        <Icon name="plus" />
      </button>
    </div>
  );
}
