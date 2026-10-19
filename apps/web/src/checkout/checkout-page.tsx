'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { viewCart, type CartView } from '../cart/cart.ts';
import { SummaryTotals, TrustLines } from '../cart/cart-parts.tsx';
import { Crumbs } from '../catalog/results.tsx';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { SellerLogo } from '../product/seller-logo.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { CheckoutSource, ServiceArea } from '../storefront/types.ts';

// Checkout of the approved design: one page with four steps (Account, Delivery address, Delivery
// by seller, Payment); a finished step shows its answer and a Change link. The order summary sits
// beside the steps from 1000px and folds on top of them below. An account is required (no guest
// checkout); the guest cart is kept and merged on log-in. Sample data: the log-in and the address
// book are not wired yet, and Pay goes to a placeholder instead of Stripe's hosted page.

type Step = 1 | 2 | 3 | 4;

interface NewAddress {
  readonly name: string;
  readonly phone: string;
  readonly street: string;
  readonly suburb: string;
  readonly postcode: string;
  readonly note: string;
}

const EMPTY: NewAddress = { name: '', phone: '', street: '', suburb: '', postcode: '', note: '' };

/** Whether a postcode is in the service area (a placeholder for the backend's area check). */
export function inServiceArea(area: ServiceArea, postcode: string): boolean {
  return (
    /^\d+$/.test(postcode) &&
    area.postcodes.some(
      (r) => postcode.length === r.from.length && postcode >= r.from && postcode <= r.to,
    )
  );
}

export function CheckoutPage({ source }: { readonly source: CheckoutSource }) {
  const t = useTranslations('checkout');
  const tc = useTranslations('catalog');
  const tcart = useTranslations('cart');
  const locale = useLocale();
  const router = useRouter();
  const { cart, cartSource, customer, setCustomer, setDeliveryAddress } = useStore();
  const view = viewCart(cart, cartSource);
  const [step, setStep] = useState<Step>(customer ? 2 : 1);
  const [choice, setChoice] = useState<string>(
    () => source.customer.addresses.find((a) => a.isDefault)?.id ?? 'new',
  );
  const [fresh, setFresh] = useState<NewAddress>(EMPTY);

  // Signed in (at step 1 or by another tab of the shell): the account step is done.
  useEffect(() => {
    if (customer && step === 1) setStep(2);
  }, [customer, step]);
  // Nothing to check out, or a seller below its minimum: back to the cart.
  const blocked = !view || view.blocked.length > 0;
  useEffect(() => {
    if (blocked) router.replace('/cart');
  }, [blocked, router]);
  if (!view || blocked) return null;

  const area = source.serviceArea;
  const freshValid =
    fresh.name.trim() !== '' &&
    fresh.phone.trim() !== '' &&
    fresh.street.trim() !== '' &&
    fresh.suburb.trim() !== '' &&
    inServiceArea(area, fresh.postcode);
  const addresses = customer?.addresses ?? [];
  const saved = addresses.find((a) => a.id === choice);
  const addressLine = saved
    ? `${saved.label}: ${saved.line}`
    : [
        fresh.street || t('new-address-summary'),
        fresh.suburb,
        fresh.postcode && `${area.region} ${fresh.postcode}`,
      ]
        .filter(Boolean)
        .join(', ');
  const money = (m: CartView['total']) => formatMoney(m, locale);

  return (
    <div className="cwrap">
      <Crumbs
        trail={[
          { label: tc('home'), href: '/' },
          { label: tcart('title'), href: '/cart' },
        ]}
        current={t('title')}
      />
      <div className="ctitle">
        <h1>{t('title')}</h1>
        <span>{t('step-of', { step })}</span>
      </div>
      <details className="cmob">
        <summary>
          {t('summary-toggle')}
          <span>
            <b className="num">{money(view.total)}</b>
            <Icon name="chevd" />
          </span>
        </summary>
        <div className="cs">
          <OrderSummary view={view} />
        </div>
      </details>
      <div className="cgrid">
        <div className="clist">
          <StepCard
            n={1}
            step={step}
            title={t('account')}
            done={customer ? t('signed-in-as', { email: customer.email }) : undefined}
            onChange={customer ? undefined : setStep}
          >
            <AccountStep
              onSignedIn={() => {
                // Sample: no sign-in call yet; the session gives the customer when it is wired.
                setCustomer(source.customer);
                setStep(2);
              }}
            />
          </StepCard>
          <StepCard
            n={2}
            step={step}
            title={t('address')}
            done={step > 2 ? addressLine : undefined}
            onChange={setStep}
          >
            <div className="stb">
              <div className="aopts" role="radiogroup" aria-label={t('address')}>
                {addresses.map((a) => (
                  <label className="aopt" key={a.id}>
                    <input
                      type="radio"
                      name="address"
                      value={a.id}
                      checked={choice === a.id}
                      onChange={() => setChoice(a.id)}
                    />
                    <b>
                      {a.label}
                      {a.isDefault ? <span className="badge">{t('default')}</span> : null}
                    </b>
                    <span>
                      {a.name}, {a.line}
                    </span>
                    <span>{a.phone}</span>
                  </label>
                ))}
                <label className="aopt">
                  <input
                    type="radio"
                    name="address"
                    value="new"
                    checked={!saved}
                    onChange={() => setChoice('new')}
                  />
                  <b>{t('new-address')}</b>
                  <span>{t('new-address-note', { area: area.name })}</span>
                </label>
              </div>
              {saved ? null : <AddressForm area={area} value={fresh} onChange={setFresh} />}
              <div>
                <button
                  className="btn"
                  type="button"
                  aria-disabled={!saved && !freshValid ? true : undefined}
                  onClick={() => {
                    if (!saved && !freshValid) return;
                    setDeliveryAddress(addressLine);
                    setStep(3);
                  }}
                >
                  {t('deliver-here')}
                </button>
              </div>
            </div>
          </StepCard>
          <StepCard
            n={3}
            step={step}
            title={t('by-seller')}
            done={
              step > 3
                ? t('deliveries', { count: view.groups.length, fee: money(view.delivery) })
                : undefined
            }
            onChange={setStep}
          >
            <div className="stb">
              <div className="infob">
                <Icon name="info" />
                <span>{t('split-note')}</span>
              </div>
              {view.groups.map((g) => (
                <div className="dsel" key={g.seller.id}>
                  <SellerLogo logo={g.seller.logo} />
                  <div>
                    <b>{g.seller.name}</b>
                    <small>
                      <Icon name="truck" />
                      {g.seller.deliveryWindow} · {tcart('items', { count: g.count })}
                    </small>
                  </div>
                  <span className="fee num">{money(g.seller.deliveryFee)}</span>
                </div>
              ))}
              <div>
                <button className="btn" type="button" onClick={() => setStep(4)}>
                  {t('continue-payment')}
                </button>
              </div>
            </div>
          </StepCard>
          <StepCard n={4} step={step} title={t('payment')}>
            <div className="stb">
              <div className="paybox">
                <div className="payhd">
                  <Icon name="lock" />
                  {t('pay-title')}
                </div>
                <p>{t('pay-body')}</p>
              </div>
              <p className="legal">{t.rich('agree-order', legalLinks)}</p>
              <div>
                <Link className="btn" href="/checkout/payment">
                  <Icon name="lock" />
                  {t('pay', { amount: money(view.total) })}
                </Link>
              </div>
            </div>
          </StepCard>
        </div>
        <div className="cs stick alt">
          <OrderSummary view={view} />
        </div>
      </div>
    </div>
  );
}

const legalLinks = {
  terms: (chunks: ReactNode) => <Link href="/terms">{chunks}</Link>,
  privacy: (chunks: ReactNode) => <Link href="/privacy">{chunks}</Link>,
};

/** The summary with each seller's lines (checkout and its phone fold). */
function OrderSummary({ view }: { readonly view: CartView }) {
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
      <SummaryTotals view={view} />
      <TrustLines />
    </>
  );
}

/** One step: number (a tick when done), title, the answer and Change when done, the body when current. */
function StepCard({
  n,
  step,
  title,
  done,
  onChange,
  children,
}: {
  readonly n: Step;
  readonly step: Step;
  readonly title: string;
  readonly done?: string | undefined;
  readonly onChange?: ((step: Step) => void) | undefined;
  readonly children: ReactNode;
}) {
  const t = useTranslations('checkout');
  const current = step === n;
  const finished = step > n || (n === 1 && done !== undefined);
  return (
    <section
      className={current ? 'stp cur' : finished ? 'stp dn' : 'stp'}
      aria-current={current ? 'step' : undefined}
    >
      <div className="sth">
        <span className="stn" aria-hidden="true">
          {finished ? <Icon name="check" /> : n}
        </span>
        <h2>
          {title}
          {finished && done ? <span className="sum">{done}</span> : null}
        </h2>
        {finished && onChange ? (
          <button
            className="lnk"
            type="button"
            aria-label={t('change-step', { step: title })}
            onClick={() => onChange(n)}
          >
            {t('change')}
          </button>
        ) : null}
      </div>
      {current ? children : null}
    </section>
  );
}

function AccountStep({ onSignedIn }: { readonly onSignedIn: () => void }) {
  const t = useTranslations('checkout');
  const [tab, setTab] = useState<'login' | 'new'>('login');
  const login = tab === 'login';
  const id = useId();
  return (
    <div className="stb">
      <div className="tabs2" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={login}
          aria-controls={`${id}-panel`}
          onClick={() => setTab('login')}
        >
          {t('log-in')}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={!login}
          aria-controls={`${id}-panel`}
          onClick={() => setTab('new')}
        >
          {t('create-account')}
        </button>
      </div>
      <form
        className="stb flush"
        id={`${id}-panel`}
        role="tabpanel"
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
  );
}

function AddressForm({
  area,
  value,
  onChange,
}: {
  readonly area: ServiceArea;
  readonly value: NewAddress;
  readonly onChange: (value: NewAddress) => void;
}) {
  const t = useTranslations('checkout');
  const set = (key: keyof NewAddress) => (text: string) => onChange({ ...value, [key]: text });
  // The postcode error shows once four digits are typed (or another length is left).
  const outside =
    value.postcode.length >= 4 && !inServiceArea(area, value.postcode)
      ? t('outside-area', { postcode: value.postcode, area: area.name })
      : undefined;
  const noteId = useId();
  return (
    <>
      <div className="frow two">
        <Field label={t('full-name')} autoComplete="name" value={value.name} onText={set('name')} />
        <Field
          label={t('mobile')}
          type="tel"
          autoComplete="tel"
          inputMode="tel"
          hint={t('mobile-hint')}
          value={value.phone}
          onText={set('phone')}
        />
      </div>
      <Field
        label={t('street')}
        autoComplete="address-line1"
        value={value.street}
        onText={set('street')}
      />
      <div className="frow three">
        <Field
          label={t('suburb')}
          autoComplete="address-level2"
          value={value.suburb}
          onText={set('suburb')}
        />
        <Field label={t('region')} value={area.region} readOnly />
        <Field
          label={t('postcode')}
          autoComplete="postal-code"
          inputMode="numeric"
          value={value.postcode}
          onText={set('postcode')}
          error={outside}
        />
      </div>
      <div className="fld">
        <label htmlFor={noteId}>{t('instructions')}</label>
        <textarea
          id={noteId}
          placeholder={t('instructions-placeholder')}
          value={value.note}
          onChange={(event) => set('note')(event.target.value)}
        />
      </div>
      <label className="chk">
        <input type="checkbox" defaultChecked />
        {t('save-address')}
      </label>
    </>
  );
}

function Field({
  label,
  hint,
  error,
  value,
  onText,
  readOnly = false,
  type = 'text',
  autoComplete,
  inputMode,
}: {
  readonly label: string;
  readonly hint?: string;
  readonly error?: string | undefined;
  readonly value?: string;
  readonly onText?: (text: string) => void;
  readonly readOnly?: boolean;
  readonly type?: string;
  readonly autoComplete?: string;
  readonly inputMode?: 'tel' | 'numeric';
}) {
  const id = useId();
  const help = error ?? hint;
  return (
    <div className={error ? 'fld bad' : 'fld'}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type={type}
        autoComplete={autoComplete}
        inputMode={inputMode}
        readOnly={readOnly}
        aria-invalid={error ? true : undefined}
        aria-describedby={help ? `${id}-help` : undefined}
        {...(onText
          ? { value: value ?? '', onChange: (event) => onText(event.target.value) }
          : value === undefined
            ? {}
            : { value })}
      />
      {error ? (
        <span className="err" id={`${id}-help`} role="alert">
          {error}
        </span>
      ) : hint ? (
        <small id={`${id}-help`}>{hint}</small>
      ) : null}
    </div>
  );
}
