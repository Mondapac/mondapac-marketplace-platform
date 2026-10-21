'use client';

import { useLocale, useTranslations } from 'next-intl';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { SellerLogo } from '../product/seller-logo.tsx';
import { useStore } from '../shell/store-context.tsx';
import { viewCart } from './cart.ts';
import { ItemThumb, LineStepper, RemoveLine, groupAnchor } from './cart-parts.tsx';

/**
 * The cart drawer of the header's cart button and the Cart tab: a right-hand dialog (380px, full
 * width on a phone; Esc and the scrim close it, focus goes back to the opener) with each seller's
 * lines, minimum-order warning and delivery fee, the total and "View cart" / "Checkout".
 * Checkout is aria-disabled while a seller is below its minimum; it then opens the cart page at
 * that seller. Adding a product does not open it.
 */
export function CartDrawer() {
  const t = useTranslations('cart');
  const locale = useLocale();
  const router = useRouter();
  const path = usePathname();
  const { cart, cartSource, discount, delivery, cartOpen: open, setCartOpen, online } = useStore();
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);
  const view = viewCart(cart, cartSource, discount, delivery);

  useEffect(() => setMounted(true), []);
  // A new page closes the drawer.
  useEffect(() => setCartOpen(false), [path, setCartOpen]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    panel.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setCartOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true });
    };
  }, [open, setCartOpen]);

  const close = () => setCartOpen(false);
  const go = (href: string) => {
    close();
    router.push(href);
  };
  const [blocked] = view?.blocked ?? [];

  if (!mounted) return null;
  return createPortal(
    <div className={open ? 'fwrap open' : 'fwrap'}>
      <div className="fscrim" onClick={close} />
      <aside
        className="fpanel cdrawer"
        id="cart-drawer"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="cart-drawer-title"
        inert={!open}
      >
        <div className="dh">
          <h2 id="cart-drawer-title">
            {t('title')}
            {view ? <span> ({t('items', { count: view.count })})</span> : null}
          </h2>
          <button className="iconbtn" type="button" aria-label={t('close')} onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        {view ? (
          <>
            <div className="fb">
              {view.groups.map((group) => {
                const { seller } = group;
                return (
                  <section className="dg" key={seller.id} aria-labelledby={`drawer-${seller.id}`}>
                    <div className="dgh">
                      <SellerLogo logo={seller.logo} />
                      <div>
                        <b id={`drawer-${seller.id}`}>{seller.name}</b>
                        <small>
                          <Icon name="truck" />
                          {seller.deliveryWindow}
                        </small>
                      </div>
                    </div>
                    {group.shortfall.amount > 0 && seller.minimumOrder ? (
                      <p className="dwarn">
                        <Icon name="info" />
                        {t('minimum-short-drawer', {
                          amount: formatMoney(group.shortfall, locale),
                          minimum: formatMoney(seller.minimumOrder, locale),
                        })}
                      </p>
                    ) : null}
                    <ul className="dl">
                      {group.lines.map((line) => (
                        <li key={line.id}>
                          <ItemThumb item={line.item} />
                          <div className="dn">
                            <b>{line.item.name}</b>
                            <span className="num">{formatMoney(line.total, locale)}</span>
                            <LineStepper line={line} small />
                            <RemoveLine line={line} />
                          </div>
                        </li>
                      ))}
                    </ul>
                    <div className="dsh">
                      <span>{t('delivery')}</span>
                      <b className="num">{formatMoney(group.deliveryFee, locale)}</b>
                    </div>
                  </section>
                );
              })}
            </div>
            <div className="ff dff">
              <div className="dtot">
                <span>{t('total')}</span>
                <b className="num">{formatMoney(view.total, locale)}</b>
                <small>{t('total-incl')}</small>
              </div>
              <button className="btn ghost" type="button" onClick={() => go('/cart')}>
                {t('view-cart')}
              </button>
              <button
                className="btn ctl"
                type="button"
                aria-disabled={blocked || !online ? true : undefined}
                onClick={() => {
                  if (!online) return;
                  go(blocked ? `/cart#${groupAnchor(blocked.seller.id)}` : '/checkout');
                }}
              >
                {t('checkout')}
              </button>
              {blocked ? (
                <p className="dwarn wide">{t('blocked-drawer', { seller: blocked.seller.name })}</p>
              ) : null}
            </div>
          </>
        ) : (
          <div className="fb">
            <div className="cempty">
              <Icon name="bag" />
              <h2>{t('empty')}</h2>
              <p>{t('empty-drawer')}</p>
              <button className="btn" type="button" onClick={close}>
                {t('keep-shopping')}
              </button>
            </div>
          </div>
        )}
      </aside>
    </div>,
    document.body,
  );
}
