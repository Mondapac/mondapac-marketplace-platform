'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Crumbs } from '../catalog/results.tsx';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { SellerLogo } from '../product/seller-logo.tsx';
import { useStore } from '../shell/store-context.tsx';
import { viewCart, type CartGroup, type CartView } from './cart.ts';
import {
  ItemThumb,
  LineStepper,
  RemoveLine,
  SummaryTotals,
  TrustLines,
  groupAnchor,
} from './cart-parts.tsx';

// The cart page of the approved design: one card per seller (delivery window, minimum-order
// progress, lines, flat delivery fee) and a sticky order summary beside it from 1000px; under
// 1000px the summary follows the list and a sticky bar sits above the tab bar. Checkout is
// blocked while a seller is below its minimum order.

/** Scrolls a blocked seller's card into view. */
export function scrollToSeller(sellerId: string) {
  document
    .getElementById(groupAnchor(sellerId))
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

export function CartPage() {
  const t = useTranslations('cart');
  const tc = useTranslations('catalog');
  const locale = useLocale();
  const router = useRouter();
  const { cart, cartSource, customer } = useStore();
  const view = viewCart(cart, cartSource);
  const [notice, setNotice] = useState(true);

  // The drawer's Checkout of a blocked cart lands here with the seller's anchor.
  useEffect(() => {
    const id = window.location.hash.slice(1);
    if (id) document.getElementById(id)?.scrollIntoView({ block: 'center' });
  }, []);

  const checkout = () => {
    if (!view) return;
    const [first] = view.blocked;
    if (first) scrollToSeller(first.seller.id);
    else router.push('/checkout');
  };
  const changed = view?.groups.flatMap((g) => g.lines).find((l) => l.item.addedAt) ?? null;
  const crumbs = <Crumbs trail={[{ label: tc('home'), href: '/' }]} current={t('title')} />;

  if (!view)
    return (
      <div className="cwrap">
        {crumbs}
        <div className="ctitle">
          <h1>{t('title')}</h1>
        </div>
        <div className="cempty">
          <Icon name="bag" />
          <h2>{t('empty')}</h2>
          <p>{t('empty-body')}</p>
          {customer ? null : <p>{t('empty-guest')}</p>}
          <Link className="btn" href="/">
            {t('browse')}
          </Link>
        </div>
      </div>
    );

  return (
    <div className="cwrap">
      {crumbs}
      <div className="ctitle">
        <h1>{t('title')}</h1>
        <span>{t('summary-line', { count: view.count, sellers: view.groups.length })}</span>
      </div>
      {notice && changed?.item.addedAt ? (
        <div className="cnote" role="status">
          <Icon name="info" />
          <p>
            {t.rich('price-updated', {
              name: changed.item.name,
              price: formatMoney(changed.item.price, locale),
              was: formatMoney(changed.item.addedAt, locale),
              b: (chunks) => <b>{chunks}</b>,
            })}
          </p>
          <button type="button" onClick={() => setNotice(false)}>
            {t('dismiss')}
          </button>
        </div>
      ) : null}
      <div className="cgrid">
        <div className="clist">
          {view.groups.map((group) => (
            <SellerGroup key={group.seller.id} group={group} notice={notice} />
          ))}
        </div>
        <div className="cs stick">
          <h2>{t('summary')}</h2>
          <SummaryTotals view={view} />
          <CheckoutAction view={view} onCheckout={checkout} />
          {customer ? null : <small>{t('guest-note')}</small>}
          <TrustLines />
        </div>
      </div>
      <div className="cbar">
        <div className="num">
          <b>{formatMoney(view.total, locale)}</b>
          <small>{t('total-incl-bar')}</small>
        </div>
        <button
          className="btn"
          type="button"
          aria-disabled={view.blocked.length > 0 || undefined}
          onClick={checkout}
        >
          {t('checkout')}
        </button>
      </div>
    </div>
  );
}

/** The blocked-seller message and the Checkout button of the summary. */
function CheckoutAction({
  view,
  onCheckout,
}: {
  readonly view: CartView;
  readonly onCheckout: () => void;
}) {
  const t = useTranslations('cart');
  const locale = useLocale();
  const [first] = view.blocked;
  return (
    <>
      {first ? (
        <div className="cblock" role="alert">
          <b>{t('blocked-title')}</b>
          {view.blocked.map((g) => (
            <span key={g.seller.id}>
              {t('blocked-seller', {
                seller: g.seller.name,
                amount: formatMoney(g.shortfall, locale),
              })}
            </span>
          ))}
          <a
            href={`#${groupAnchor(first.seller.id)}`}
            onClick={(event) => {
              event.preventDefault();
              scrollToSeller(first.seller.id);
            }}
          >
            {t('go-to-seller', { seller: first.seller.name })}
          </a>
        </div>
      ) : null}
      <button
        className="btn wide"
        type="button"
        aria-disabled={first ? true : undefined}
        onClick={onCheckout}
      >
        {t('checkout')}
      </button>
    </>
  );
}

function SellerGroup({ group, notice }: { readonly group: CartGroup; readonly notice: boolean }) {
  const t = useTranslations('cart');
  const locale = useLocale();
  const money = (m: CartGroup['subtotal']) => formatMoney(m, locale);
  const { seller } = group;
  const minimum = seller.minimumOrder;
  const heading = `${groupAnchor(seller.id)}-title`;
  return (
    <section className="cg" id={groupAnchor(seller.id)} aria-labelledby={heading}>
      <header className="cgh">
        <SellerLogo logo={seller.logo} />
        <div>
          <h2 id={heading}>{seller.name}</h2>
          <small>
            <Icon name="truck" />
            {t('delivery-window', { window: seller.deliveryWindow })}
          </small>
        </div>
      </header>
      {minimum && minimum.amount > 0 ? (
        <div className={group.shortfall.amount > 0 ? 'cmin warn' : 'cmin ok'}>
          <p>
            <Icon name={group.shortfall.amount > 0 ? 'info' : 'check'} />
            {group.shortfall.amount > 0
              ? t('minimum-short', { amount: money(group.shortfall), minimum: money(minimum) })
              : t('minimum-reached', { minimum: money(minimum) })}
          </p>
          <i
            aria-hidden="true"
            style={{
              ['--v' as string]: `${Math.min(100, Math.round((group.subtotal.amount * 100) / minimum.amount))}%`,
            }}
          />
        </div>
      ) : null}
      <ul className="cli">
        {group.lines.map((line) => (
          <li className="ci" key={line.id}>
            <ItemThumb item={line.item} />
            <div className="cin">
              <b>{line.item.name}</b>
              {line.item.lowStock === undefined ? null : (
                <span className="low">{t('only-left', { count: line.item.lowStock })}</span>
              )}
              {notice && line.item.addedAt ? (
                <span className="pn">{t('line-price-updated')}</span>
              ) : null}
              <RemoveLine line={line} />
            </div>
            <div className="cqp">
              <LineStepper line={line} />
              <div className="cpr num">
                <b>{money(line.total)}</b>
                <small>{t('each', { price: money(line.item.price) })}</small>
              </div>
            </div>
          </li>
        ))}
      </ul>
      <div className="cgf">
        <span>
          <Icon name="truck" />
          {t('delivery-from-seller')}
        </span>
        <b className="num">{money(seller.deliveryFee)}</b>
      </div>
    </section>
  );
}
