'use client';

import { useTranslations } from 'next-intl';
import { useId, useRef, type KeyboardEvent } from 'react';
import { useSelected } from './selected-offer.tsx';

/**
 * The Variant picker of the buy box: one radio group (arrow keys move and choose, Tab enters and
 * leaves it). A Variant every seller is out of is greyed, says "Out of stock" and cannot be
 * chosen; the one the page opened on stays chosen even then, so the buy button says why it is off.
 * Nothing shows for a product with one Variant.
 */
export function VariantPicker() {
  const t = useTranslations('product');
  const { product, variant, select } = useSelected();
  const group = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const variants = product.variants;
  if (variants === undefined || variant === undefined) return null;
  const choosable = (id: string) => id === variant.id || variants.find((v) => v.id === id)?.inStock;

  function move(event: KeyboardEvent<HTMLDivElement>) {
    const rtl = group.current !== null && getComputedStyle(group.current).direction === 'rtl';
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const back = rtl ? 'ArrowRight' : 'ArrowLeft';
    const step =
      event.key === forward || event.key === 'ArrowDown'
        ? 1
        : event.key === back || event.key === 'ArrowUp'
          ? -1
          : 0;
    if (step === 0 || variants === undefined) return;
    event.preventDefault();
    const here = variants.findIndex((v) => v.id === variant?.id);
    for (let i = 1; i <= variants.length; i++) {
      const next = variants[(here + step * i + variants.length * i) % variants.length]!;
      if (next.inStock) {
        select(next.id);
        group.current?.querySelector<HTMLElement>(`[data-variant="${next.id}"]`)?.focus();
        return;
      }
    }
  }

  return (
    <div className="vpick">
      <div className="vpick-title" id={titleId}>
        {t('variant-choose')}
      </div>
      <div
        ref={group}
        className="vpick-row"
        role="radiogroup"
        aria-labelledby={titleId}
        onKeyDown={move}
      >
        {variants.map((v, index) => {
          const checked = v.id === variant.id;
          const off = !v.inStock;
          return (
            <button
              key={v.id}
              type="button"
              role="radio"
              data-variant={v.id}
              className={`vpick-opt${checked ? ' on' : ''}${off ? ' off' : ''}`}
              aria-checked={checked}
              aria-disabled={off && !checked ? true : undefined}
              tabIndex={checked ? 0 : -1}
              onClick={() => {
                if (choosable(v.id)) select(v.id);
              }}
            >
              <span>
                <bdi>{v.label ?? t('variant-n', { n: index + 1 })}</bdi>
              </span>
              {off ? <small>{t('out-of-stock')}</small> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
