'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState } from 'react';
import { viewCart, type CartView } from '../cart/cart.ts';
import { DiscountBox, ItemThumb, SummaryTotals, TrustLines } from '../cart/cart-parts.tsx';
import { addressLine as savedLine, recipientName } from '../account/address-line.ts';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type {
  CheckoutSource,
  PayAnswer,
  PaymentMethod,
  PayRequest,
  QuoteAddress,
} from '../storefront/types.ts';
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
import {
  DeliverySection,
  deliveryChoices,
  deliveryStatus,
  useDeliveryOptions,
} from './delivery-section.tsx';
import { payOrder } from './actions.ts';
import { firstFieldToFix, revealField } from './focus-error.ts';
import {
  legalLinks,
  PaymentSection,
  PayButton,
  type PayBlock,
  type PayNotice,
} from './payment-section.tsx';
import { CheckoutProgress } from './progress.tsx';
import { useStripeCard } from './stripe-card.ts';

export { inServiceArea } from './address-section.tsx';

// Checkout of the approved design (cart-a-teal, 21 Oct 2026): a guest logs in first; signed in,
// one page holds Delivery address, Delivery method and Payment method with one Pay button. From
// 1000px the order summary and a help card sit on the right; below, the summary folds on top, the
// discount code sits under it and Pay ends the form. An account is required (no guest checkout);
// the guest cart is kept and merged on log-in. Sample data: the log-in, the address book and the
// courier are not wired yet. Pay checks the order again on the server (Express prices, stock):
// the Card tile sends Stripe's confirmation token, the Stripe tile goes to Stripe's hosted page
// (the sample stand-in until ordering takes payments).

export function CheckoutPage({ source }: { readonly source: CheckoutSource }) {
  const t = useTranslations('checkout');
  const methodName = (method: string | undefined) =>
    t('method-label', { method: method ?? 'other' });
  const router = useRouter();
  const reason = useId();
  const {
    cart,
    cartSource,
    discount,
    deliveryWish,
    setDelivery,
    customer,
    setCustomer,
    setDeliveryAddress,
    online,
    notes,
    limitLines,
    setStockChanges,
    clearCart,
    setPlacedOrder,
  } = useStore();
  const sellerIds = viewCart(cart, cartSource)?.groups.map((g) => g.seller.id) ?? [];
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
  const { states, retry, replace } = useDeliveryOptions(
    customer ? quoteAddress : null,
    sellerIds,
    online,
    source.areaCheck === 'api',
  );
  const [now] = useState(() => new Date());
  const choices = deliveryChoices(
    sellerIds,
    deliveryWish,
    states,
    now,
    viewCart(cart, cartSource)?.total.currency ?? 'AUD',
  );
  const view = viewCart(cart, cartSource, discount, choices);
  const [method, setMethod] = useState<PaymentMethod>('card');
  const [cardName, setCardName] = useState('');
  const [nameError, setNameError] = useState(false);
  const [notice, setNotice] = useState<PayNotice | null>(null);
  const [paying, setPaying] = useState(false);
  const stripeKey =
    customer && method === 'card' && source.card.kind === 'stripe'
      ? source.card.publishableKey
      : null;
  const stripeCard = useStripeCard(stripeKey, view?.total ?? null);

  // Back from Stripe's page through the browser's cache: the page is not still paying.
  useEffect(() => {
    const shown = (event: PageTransitionEvent) => {
      if (event.persisted) setPaying(false);
    };
    window.addEventListener('pageshow', shown);
    return () => window.removeEventListener('pageshow', shown);
  }, []);

  // Signed in from the Log in step: the address section takes the focus (the form is gone).
  const wasGuest = useRef(customer === null);
  useEffect(() => {
    if (customer === null || !wasGuest.current) return;
    wasGuest.current = false;
    document.querySelector<HTMLElement>('#checkout-address h2')?.focus();
  }, [customer]);

  // Nothing to check out, or a seller below its minimum: back to the cart (not once the order is
  // placed: the cart is emptied as the confirmation opens).
  const placed = useRef(false);
  const blocked = !view || view.blocked.length > 0;
  useEffect(() => {
    if (blocked && !placed.current) router.replace('/cart');
  }, [blocked, router]);
  if (!view || blocked) return null;

  const addressLine = saved
    ? `${recipientName(saved)}: ${savedLine(saved, source.serviceArea.regionCode)}`
    : newAddressLine(fresh, source.serviceArea, t('new-address-summary'));
  const ready = deliveryStatus(sellerIds, states, choices);
  const block: PayBlock = !online
    ? 'offline'
    : !saved && !freshReady
      ? 'address'
      : ready === 'loading'
        ? 'loading'
        : ready === 'problem'
          ? 'delivery'
          : ready === 'choose'
            ? 'choose'
            : notice?.kind === 'stock-changed'
              ? 'stock'
              : stripeKey !== null && stripeCard.state !== 'ready'
                ? 'card'
                : null;

  /** What Pay found: the order is placed, Stripe's page opens, or the page says what changed. */
  const settle = (answer: PayAnswer) => {
    if (answer.kind === 'paid') {
      placed.current = true;
      setStockChanges(null);
      setPlacedOrder({
        reference: answer.reference,
        view,
        address: addressLine,
        discountCode: discount?.code ?? null,
        notes,
      });
      clearCart();
      router.push('/checkout/confirmation');
      return;
    }
    if (answer.kind === 'redirect') {
      // Only Stripe's hosted page or a page of this site; anything else is refused. The URL is
      // parsed as the browser would (a `/\host` or a tab in the path would leave the site).
      const to = safeRedirect(answer.url, window.location.origin);
      if (to !== null) {
        setDelivery(choices);
        setDeliveryAddress(addressLine);
        if (to.own) router.push(to.href);
        else window.location.assign(to.href);
        return;
      }
      answer = { kind: 'failed' };
    }
    setPaying(false);
    if (answer.kind === 'price-changed') {
      replace(answer.options);
      setNotice({
        kind: 'price-changed',
        changes: answer.changes.map((c) => ({
          seller: cartSource.sellers[c.sellerId]?.name ?? c.sellerId,
          method: methodName(choices[c.sellerId]?.method),
          was: c.was,
          now: c.now,
        })),
      });
    } else if (answer.kind === 'stock-changed') {
      const changes = answer.changes.map((c) => ({
        item: cartSource.items[c.itemId]?.name ?? c.itemId,
        was: c.was,
        now: c.now,
      }));
      // The cart says it too: with every line gone, or a seller now below its minimum, checkout
      // sends the buyer there.
      setStockChanges(changes);
      limitLines(Object.fromEntries(answer.changes.map((c) => [c.itemId, c.now])));
      setNotice({ kind: 'stock-changed', changes });
    } else setNotice(answer);
    document.querySelector<HTMLElement>('#checkout-payment h2')?.focus();
  };

  const pay = async () => {
    if (paying) return;
    if (block === null && quoteAddress !== null) {
      let token: string | null = null;
      if (method === 'card' && source.card.kind === 'stripe') {
        if (cardName.trim() === '') {
          setNameError(true);
          const nameField = document.querySelector<HTMLElement>('#checkout-payment .cfm input');
          if (nameField) revealField(nameField);
          return;
        }
        setPaying(true);
        const made = await stripeCard.tokenize(cardName.trim());
        if (made.kind !== 'token') {
          setPaying(false);
          if (made.kind === 'invalid') stripeCard.focus();
          else {
            setNotice({ kind: 'failed' });
            document.querySelector<HTMLElement>('#checkout-payment h2')?.focus();
          }
          return;
        }
        token = made.id;
      }
      setPaying(true);
      setNotice(null);
      const request: PayRequest = {
        method,
        confirmationToken: token,
        address: quoteAddress,
        lines: Object.fromEntries(Object.entries(cart).map(([id, line]) => [id, line.quantity])),
        delivery: Object.fromEntries(
          Object.entries(choices).map(([id, c]) => [
            id,
            { method: c.method, quoteId: c.quoteId, window: c.window, total: c.total },
          ]),
        ),
        discountCode: discount?.code ?? null,
        total: view.total,
      };
      settle(await payOrder(request).catch((): PayAnswer => ({ kind: 'failed' })));
      return;
    }
    // Blocked: the focus goes to the first thing to fix.
    const address = document.getElementById('checkout-address');
    const target =
      block === 'address'
        ? address
          ? firstFieldToFix(address)
          : null
        : block === 'delivery'
          ? document.querySelector<HTMLElement>('.dcard .dwarn2 button, .dcard .dwarn2 a')
          : block === 'choose'
            ? document.querySelector<HTMLElement>('.dcard input[type=radio]:not(:disabled)')
            : null;
    if (target) revealField(target);
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
      <SummaryDisclosure view={view} />
      <div className="ckdc" inert={paying}>
        <DiscountBox startOpen />
      </div>
      <div className="cgrid">
        <div className="cklist">
          {/* While Pay waits for its answer, the order cannot change under it. */}
          <div className="ckwait" inert={paying}>
            <AddressSection
              source={source}
              addresses={addresses}
              choice={choice}
              onChoice={setChoice}
              fresh={fresh}
              onFresh={setFresh}
              areaState={areaState}
            />
            <DeliverySection view={view} states={states} onRetry={retry} />
          </div>
          <PaymentSection
            view={view}
            method={method}
            onMethod={(next) => {
              setMethod(next);
              if (notice?.kind === 'declined') setNotice(null);
            }}
            card={{
              setup: source.card,
              target: stripeCard.target,
              state: stripeCard.state,
              onRetry: stripeCard.retry,
              name: cardName,
              onName: setCardName,
              nameError,
            }}
            notice={notice}
            block={block}
            paying={paying}
            onPay={() => void pay()}
            reasonId={`${reason}-form`}
          />
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
            <div className="ckwait" inert={paying}>
              <DiscountBox startOpen />
            </div>
            <SummaryTotals view={view} deliveryLoading={ready === 'loading'} />
            <PayButton
              view={view}
              method={method}
              block={block}
              paying={paying}
              onPay={() => void pay()}
              className="ckpd"
              reasonId={`${reason}-side`}
            />
            {block !== null && block !== 'stock' ? (
              <small id={`${reason}-side`}>{t(`pay-block-${block}`)}</small>
            ) : null}
            <small className="legal">{t.rich('agree-order', legalLinks)}</small>
          </div>
          <HelpCard />
        </div>
      </div>
      <PayBar
        view={view}
        method={method}
        block={block}
        paying={paying}
        onPay={() => void pay()}
        reasonId={`${reason}-bar`}
      />
    </div>
  );
}

/**
 * The folded order summary on phone and tablet: one button showing the item count and the total,
 * which opens the same summary the guest sees. A button with aria-expanded and aria-controls, not
 * a native disclosure, so the state is the page's own and the label can carry the count.
 */
function SummaryDisclosure({ view }: { readonly view: CartView }) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  const [open, setOpen] = useState(false);
  const panel = useId();
  const count = view.groups.reduce(
    (sum, g) => sum + g.lines.reduce((lines, l) => lines + l.quantity, 0),
    0,
  );
  return (
    <div className="cmob" data-open={open ? '' : undefined}>
      <button
        className="cmob-btn"
        type="button"
        aria-expanded={open}
        aria-controls={panel}
        onClick={() => setOpen(!open)}
      >
        <span className="cmob-t">
          {t('summary-toggle')}
          <small>{t('summary-items', { count })}</small>
        </span>
        <span className="cmob-v">
          <b className="num">{formatMoney(view.total, locale)}</b>
          <Icon name="chevd" />
        </span>
      </button>
      <div className="cs" id={panel} hidden={!open}>
        <MiniSummary view={view} discount={false} heading={false} />
      </div>
    </div>
  );
}

/** The sticky Pay bar of phone and tablet: the same Pay button (one action, `pay`), always in reach. */
function PayBar({
  view,
  method,
  block,
  paying,
  onPay,
  reasonId,
}: {
  readonly view: CartView;
  readonly method: PaymentMethod;
  readonly block: PayBlock;
  readonly paying: boolean;
  readonly onPay: () => void;
  readonly reasonId: string;
}) {
  const t = useTranslations('checkout');
  return (
    <div className="paybar">
      {block !== null && block !== 'stock' ? (
        <small id={reasonId}>{t(`pay-block-${block}`)}</small>
      ) : null}
      <PayButton
        view={view}
        method={method}
        block={block}
        paying={paying}
        onPay={onPay}
        reasonId={reasonId}
      />
      <small className="legal">{t.rich('agree-order', legalLinks)}</small>
    </div>
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
              <small>
                {g.seller.name} ·{' '}
                <span className="nw">{t('item-qty', { quantity: l.quantity })}</span>
              </small>
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
  heading = true,
}: {
  readonly view: CartView;
  readonly discount?: boolean;
  /** False inside the folded summary, whose button already names it. */
  readonly heading?: boolean;
}) {
  const t = useTranslations('cart');
  const tco = useTranslations('checkout');
  const locale = useLocale();
  return (
    <>
      {heading ? <h2>{t('summary')}</h2> : null}
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

/**
 * Where Pay's redirect may go: Stripe's hosted page, or a page of this site (pushed as its path).
 * Parsed with the browser's own rules, so `/\host`, a tab or `//host` cannot leave the site.
 */
export function safeRedirect(
  url: string,
  origin: string,
): { readonly own: boolean; readonly href: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(url, origin);
  } catch {
    return null;
  }
  if (parsed.origin === origin && url.startsWith('/'))
    return { own: true, href: `${parsed.pathname}${parsed.search}${parsed.hash}` };
  if (parsed.origin === 'https://checkout.stripe.com') return { own: false, href: parsed.href };
  return null;
}
