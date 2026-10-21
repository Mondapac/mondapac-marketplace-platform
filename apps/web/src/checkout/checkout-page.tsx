'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { viewCart, type CartView } from '../cart/cart.ts';
import { DiscountBox, ItemThumb, SummaryTotals, TrustLines } from '../cart/cart-parts.tsx';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { CheckoutSource, QuoteAddress } from '../storefront/types.ts';
import {
  AddressSection,
  EMPTY_ADDRESS,
  Field,
  newAddressComplete,
  newAddressLine,
  newPostcode,
  useDeliveryArea,
  type NewAddress,
} from './address-section.tsx';
import { DeliverySection, quotesReady, useDeliveryQuotes } from './delivery-section.tsx';
import { CheckoutProgress } from './progress.tsx';

export { inServiceArea } from './address-section.tsx';

// Checkout of the approved design (cart-a-teal, 21 Oct 2026): a guest logs in first; signed in,
// one page holds Delivery address, Delivery method and Payment method with one Pay button. From
// 1000px the order summary and a help card sit on the right; below, the summary folds on top, the
// discount code sits under it and Pay ends the form. An account is required (no guest checkout);
// the guest cart is kept and merged on log-in. Sample data: the log-in, the address book and the
// courier are not wired yet, and Pay goes to a placeholder instead of Stripe's hosted page.

/** Why Pay is off, for the line under it; null when the buyer can pay. */
type PayBlock = 'address' | 'loading' | 'delivery' | 'offline' | null;

export function CheckoutPage({ source }: { readonly source: CheckoutSource }) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  const router = useRouter();
  const {
    cart,
    cartSource,
    discount,
    delivery,
    setDelivery,
    customer,
    setCustomer,
    setDeliveryAddress,
    online,
  } = useStore();
  const view = viewCart(cart, cartSource, discount, delivery);
  const addresses = customer?.addresses ?? [];
  const [choice, setChoice] = useState<string>(
    () => source.customer.addresses.find((a) => a.isDefault)?.id ?? 'new',
  );
  const [fresh, setFresh] = useState<NewAddress>(EMPTY_ADDRESS);
  const areaState = useDeliveryArea(source, newPostcode(fresh));
  const saved = addresses.find((a) => a.id === choice);
  const freshReady = newAddressComplete(fresh) && areaState === 'in';
  const quoteAddress: QuoteAddress | null = saved
    ? { kind: 'saved', id: saved.id }
    : freshReady
      ? { kind: 'new', postcode: newPostcode(fresh) }
      : null;
  const sellerIds = view?.groups.map((g) => g.seller.id) ?? [];
  const { quotes, retry } = useDeliveryQuotes(customer ? quoteAddress : null, sellerIds);

  // A new quote replaces the Express price chosen before; no Express price means Scheduled.
  useEffect(() => {
    for (const [sellerId, choice] of Object.entries(delivery)) {
      const quote = quotes[sellerId];
      if (choice.speed !== 'express' || quote === undefined || quote.kind === 'loading') continue;
      const express = quote.kind === 'quote' ? quote.express : null;
      if (express === null) setDelivery(sellerId, { speed: 'scheduled' });
      else if (express.amount !== choice.fee.amount)
        setDelivery(sellerId, { speed: 'express', fee: express });
    }
  }, [quotes, delivery, setDelivery]);

  // Signed in from the Log in step: the address section takes the focus (the form is gone).
  const wasGuest = useRef(customer === null);
  useEffect(() => {
    if (customer === null || !wasGuest.current) return;
    wasGuest.current = false;
    document.querySelector<HTMLElement>('#checkout-address h2')?.focus();
  }, [customer]);

  // Nothing to check out, or a seller below its minimum: back to the cart.
  const blocked = !view || view.blocked.length > 0;
  useEffect(() => {
    if (blocked) router.replace('/cart');
  }, [blocked, router]);
  if (!view || blocked) return null;

  const addressLine = saved
    ? `${saved.label}: ${saved.line}`
    : newAddressLine(fresh, source.serviceArea, t('new-address-summary'));
  const ready = quotesReady(quotes);
  const block: PayBlock = !online
    ? 'offline'
    : !saved && !freshReady
      ? 'address'
      : ready === 'loading'
        ? 'loading'
        : ready === 'problem'
          ? 'delivery'
          : null;
  const pay = () => {
    if (block !== null) return;
    setDeliveryAddress(addressLine);
    router.push('/checkout/payment');
  };
  const toAddress = () => {
    const section = document.getElementById('checkout-address');
    section?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    section?.querySelector('h2')?.focus({ preventScroll: true });
  };

  const title = (
    <div className="ctitle">
      <h1>{t('title')}</h1>
    </div>
  );
  if (!customer)
    return (
      <div className="cwrap">
        {title}
        <CheckoutProgress current="login" signedIn={false} />
        <div className="cgrid">
          <div className="clist">
            <AccountStep
              // Sample: no sign-in call yet; the session gives the customer when it is wired.
              onSignedIn={() => setCustomer(source.customer)}
            />
          </div>
          <div className="cs stick alt">
            <MiniSummary view={view} />
          </div>
        </div>
      </div>
    );

  return (
    <div className="cwrap">
      {title}
      <CheckoutProgress current="pay" signedIn />
      <details className="cmob">
        <summary>
          {t('summary-toggle')}
          <span>
            <b className="num">{formatMoney(view.total, locale)}</b>
            <Icon name="chevd" />
          </span>
        </summary>
        <div className="cs">
          <MiniSummary view={view} discount={false} />
        </div>
      </details>
      <div className="ckdc">
        <DiscountBox startOpen />
      </div>
      <div className="cgrid">
        <div className="cklist">
          <AddressSection
            source={source}
            addresses={addresses}
            choice={choice}
            onChoice={setChoice}
            fresh={fresh}
            onFresh={setFresh}
            areaState={areaState}
          />
          <DeliverySection
            view={view}
            quotes={quotes}
            onRetry={retry}
            onChangeAddress={toAddress}
            addressLine={addressLine.replace(/^[^:]*: /, '')}
          />
          <PaymentSection view={view} block={block} onPay={pay} />
        </div>
        <div className="ckside">
          <div className="cs stick alt">
            <div className="cks2">
              <h2>{t('summary-toggle')}</h2>
              <Link className="lnk" href="/cart">
                {t('edit-cart')}
              </Link>
            </div>
            <ItemList view={view} />
            <DiscountBox startOpen />
            <SummaryTotals view={view} />
            <PayButton view={view} block={block} onPay={pay} className="ckpd" />
            {block !== null && block !== 'offline' ? (
              <small>{t(`pay-block-${block}`)}</small>
            ) : null}
            <small className="legal">{t.rich('agree-order', legalLinks)}</small>
          </div>
          <HelpCard />
        </div>
      </div>
    </div>
  );
}

const legalLinks = {
  terms: (chunks: ReactNode) => <Link href="/terms">{chunks}</Link>,
  privacy: (chunks: ReactNode) => <Link href="/privacy">{chunks}</Link>,
};

/** The Payment method section: Stripe's hosted page; on phone and tablet, Pay ends the form. */
function PaymentSection({
  view,
  block,
  onPay,
}: {
  readonly view: CartView;
  readonly block: PayBlock;
  readonly onPay: () => void;
}) {
  const t = useTranslations('checkout');
  const heading = useId();
  return (
    <section className="cks" aria-labelledby={heading}>
      <h2 id={heading}>{t('payment-method')}</h2>
      <div className="paybox">
        <div className="payhd">
          <Icon name="lock" />
          {t('pay-title')}
        </div>
        <p>{t('pay-body')}</p>
      </div>
      <div className="ckpm">
        <PayButton view={view} block={block} onPay={onPay} />
        {block !== null && block !== 'offline' ? (
          <p className="legal">{t(`pay-block-${block}-above`)}</p>
        ) : null}
        <p className="legal">{t.rich('agree-order', legalLinks)}</p>
      </div>
    </section>
  );
}

function PayButton({
  view,
  block,
  onPay,
  className,
}: {
  readonly view: CartView;
  readonly block: PayBlock;
  readonly onPay: () => void;
  readonly className?: string;
}) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  return (
    <button
      className={className ? `btn wide ${className}` : 'btn wide'}
      type="button"
      data-pay=""
      aria-disabled={block === null ? undefined : true}
      onClick={onPay}
    >
      <Icon name="lock" />
      {t('pay', { amount: formatMoney(view.total, locale) })}
    </button>
  );
}

/** The right column's items: photo, name, seller and quantity, line total. */
function ItemList({ view }: { readonly view: CartView }) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  return (
    <ul className="ckit">
      {view.groups.flatMap((g) =>
        g.lines.map((l) => (
          <li key={l.id}>
            <ItemThumb item={l.item} />
            <div>
              <b>{l.item.name}</b>
              <small>{t('item-meta', { seller: g.seller.name, quantity: l.quantity })}</small>
            </div>
            <span className="num">{formatMoney(l.total, locale)}</span>
          </li>
        )),
      )}
    </ul>
  );
}

/** The folded summary (phone and tablet) and the guest's summary: lines by seller and totals. */
function MiniSummary({
  view,
  discount = true,
}: {
  readonly view: CartView;
  readonly discount?: boolean;
}) {
  const t = useTranslations('cart');
  const tco = useTranslations('checkout');
  const locale = useLocale();
  return (
    <>
      <h2>{t('summary')}</h2>
      <ul className="cmini">
        {view.groups.map((g) => (
          <li key={g.seller.id}>
            <span className="sn">{g.seller.name}</span>
            <ul>
              {g.lines.map((l) => (
                <li key={l.id}>
                  <b>{tco('line', { quantity: l.quantity, name: l.item.name })}</b>
                  <span className="num">{formatMoney(l.total, locale)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {discount ? <DiscountBox /> : null}
      <SummaryTotals view={view} />
      <TrustLines />
    </>
  );
}

/** "Need help?": email and the delivery and returns answers (no chat or phone: not decided). */
function HelpCard() {
  const t = useTranslations('checkout');
  const email = useTranslations('footer')('email');
  return (
    <div className="ckhelp">
      <h2>{t('help-title')}</h2>
      <a href={`mailto:${email}`}>
        <Icon name="mail" />
        <span>
          <b>{t('help-email')}</b>
          <small>{email}</small>
        </span>
      </a>
      <Link href="/help/delivery">
        <Icon name="info" />
        <span>
          <b>{t('help-delivery')}</b>
          <small>{t('help-delivery-note')}</small>
        </span>
      </Link>
    </div>
  );
}

/** The guest's Log in step: log in or create an account; the cart is kept. */
function AccountStep({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const t = useTranslations('checkout');
  const [tab, setTab] = useState<'login' | 'new'>('login');
  const login = tab === 'login';
  const id = useId();
  return (
    <section className="stp cur" aria-labelledby={`${id}-h`}>
      <div className="sth">
        <span className="stn" aria-hidden="true">
          1
        </span>
        <h2 id={`${id}-h`}>{t('account')}</h2>
      </div>
      <div className="stb">
        <div className="tabs2" role="group" aria-label={t('account')}>
          <button
            type="button"
            aria-pressed={login}
            aria-controls={`${id}-form`}
            onClick={() => setTab('login')}
          >
            {t('log-in')}
          </button>
          <button
            type="button"
            aria-pressed={!login}
            aria-controls={`${id}-form`}
            onClick={() => setTab('new')}
          >
            {t('create-account')}
          </button>
        </div>
        <form
          className="stb flush"
          id={`${id}-form`}
          onSubmit={(event) => {
            event.preventDefault();
            onSignedIn();
          }}
        >
          {login ? (
            <>
              <Field label={t('email')} type="email" autoComplete="email" />
              <Field label={t('password')} type="password" autoComplete="current-password" />
              <Link className="lnk" href="/account">
                {t('forgot')}
              </Link>
            </>
          ) : (
            <>
              <Field label={t('full-name')} autoComplete="name" />
              <Field label={t('email')} type="email" autoComplete="email" />
              <Field
                label={t('password')}
                type="password"
                autoComplete="new-password"
                hint={t('password-hint')}
              />
              <p className="legal">{t.rich('agree-account', legalLinks)}</p>
            </>
          )}
          <div className="infob">
            <Icon name="info" />
            <span>{t('cart-kept')}</span>
          </div>
          <div>
            <button className="btn" type="submit">
              {login ? t('log-in-continue') : t('create-continue')}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
