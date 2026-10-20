'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { viewCart, type CartView } from '../cart/cart.ts';
import { DiscountBox, SummaryTotals, TrustLines } from '../cart/cart-parts.tsx';
import { Crumbs } from '../catalog/results.tsx';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { SellerLogo } from '../product/seller-logo.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { CheckoutSource, ServiceArea } from '../storefront/types.ts';
import { deliveryAreaFor } from './actions.ts';

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

/** Whether a postcode is in the sample service area (the API answers once API_BASE_URL is set). */
export function inServiceArea(area: ServiceArea, postcode: string): boolean {
  return (
    /^\d+$/.test(postcode) &&
    area.postcodes.some(
      (r) => postcode.length === r.from.length && postcode >= r.from && postcode <= r.to,
    )
  );
}

/** Where a new address's postcode stands: `checking` while the API has not answered. */
type AreaState = 'in' | 'out' | 'checking' | 'failed';

/** Shortest postcode worth asking about (an AU postcode has four digits). */
const AREA_CHECK_MIN = 4;

/**
 * The delivery area answer for a postcode: the sample list in the browser, or the API's answer
 * (one read per postcode typed, the last one wins).
 */
function useDeliveryArea(source: CheckoutSource, postcode: string): AreaState {
  const api = source.areaCheck === 'api';
  const value = postcode.trim();
  const [answer, setAnswer] = useState<{ readonly postcode: string; readonly state: AreaState }>();
  useEffect(() => {
    if (!api || value.length < AREA_CHECK_MIN) return;
    let live = true;
    const settle = (state: AreaState) => {
      if (live) setAnswer({ postcode: value, state });
    };
    deliveryAreaFor(value).then(
      (read) =>
        settle(
          read.kind === 'off'
            ? inServiceArea(source.serviceArea, value)
              ? 'in'
              : 'out'
            : read.kind,
        ),
      () => settle('failed'),
    );
    return () => {
      live = false;
    };
  }, [api, value, source.serviceArea]);
  if (!api) return inServiceArea(source.serviceArea, postcode) ? 'in' : 'out';
  if (value.length < AREA_CHECK_MIN) return 'out';
  return answer?.postcode === value ? answer.state : 'checking';
}

export function CheckoutPage({ source }: { readonly source: CheckoutSource }) {
  const t = useTranslations('checkout');
  const tc = useTranslations('catalog');
  const tcart = useTranslations('cart');
  const locale = useLocale();
  const router = useRouter();
  const { cart, cartSource, discount, customer, setCustomer, setDeliveryAddress } = useStore();
  const view = viewCart(cart, cartSource, discount);
  const [step, setStep] = useState<Step>(customer ? 2 : 1);
  const [choice, setChoice] = useState<string>(
    () => source.customer.addresses.find((a) => a.isDefault)?.id ?? 'new',
  );
  const [fresh, setFresh] = useState<NewAddress>(EMPTY);
  const areaState = useDeliveryArea(source, fresh.postcode);

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
    areaState === 'in';
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
              {saved ? null : (
                <AddressForm area={area} areaState={areaState} value={fresh} onChange={setFresh} />
              )}
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
                  <div className="dnote">
                    <SellerNote sellerId={g.seller.id} sellerName={g.seller.name} />
                  </div>
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
      <DiscountBox />
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
  // The step that becomes current takes the focus: the button that moved on is gone.
  const heading = useRef<HTMLHeadingElement>(null);
  const was = useRef(current);
  useEffect(() => {
    if (current && !was.current) heading.current?.focus();
    was.current = current;
  }, [current]);
  return (
    <section
      className={current ? 'stp cur' : finished ? 'stp dn' : 'stp'}
      aria-current={current ? 'step' : undefined}
    >
      <div className="sth">
        <span className="stn" aria-hidden="true">
          {finished ? <Icon name="check" /> : n}
        </span>
        <h2 ref={heading} tabIndex={-1}>
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
  );
}

function AddressForm({
  area,
  areaState,
  value,
  onChange,
}: {
  readonly area: ServiceArea;
  readonly areaState: AreaState;
  readonly value: NewAddress;
  readonly onChange: (value: NewAddress) => void;
}) {
  const t = useTranslations('checkout');
  const set = (key: keyof NewAddress) => (text: string) => onChange({ ...value, [key]: text });
  // The postcode error shows once four digits are typed, or when the field is left too short.
  const [left, setLeft] = useState(false);
  const shown = value.postcode.length >= AREA_CHECK_MIN || (left && value.postcode !== '');
  const outside = !shown
    ? undefined
    : areaState === 'out'
      ? t('outside-area', { postcode: value.postcode, area: area.name })
      : areaState === 'failed'
        ? t('area-check-failed')
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
          onText={(text) => {
            setLeft(false);
            set('postcode')(text);
          }}
          onLeave={() => setLeft(true)}
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
  onLeave,
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
  readonly onLeave?: () => void;
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
        onBlur={onLeave}
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

const NOTE_MAX = 200;

/** "Add a note for this seller": plain text for delivery or packing, 200 characters at most. */
function SellerNote({
  sellerId,
  sellerName,
}: {
  readonly sellerId: string;
  readonly sellerName: string;
}) {
  const t = useTranslations('checkout');
  const { notes, setNote } = useStore();
  const value = notes[sellerId] ?? '';
  const [open, setOpen] = useState(value !== '');
  const area = useRef<HTMLTextAreaElement>(null);
  const id = useId();
  useEffect(() => {
    // Focus the empty box the link just opened; a note being typed is already focused.
    if (open && value === '') area.current?.focus();
  }, [open, value]);
  if (!open)
    return (
      <button className="lnk nbt" type="button" onClick={() => setOpen(true)}>
        <Icon name="note" />
        {t('note-open')}
      </button>
    );
  return (
    <div className="nbox">
      <label htmlFor={id}>{t('note-label', { seller: sellerName })}</label>
      <textarea
        id={id}
        ref={area}
        rows={2}
        maxLength={NOTE_MAX}
        placeholder={t('note-placeholder')}
        aria-describedby={`${id}-count ${id}-help`}
        value={value}
        onChange={(event) => setNote(sellerId, event.target.value.slice(0, NOTE_MAX))}
      />
      <small className="ncnt num" id={`${id}-count`}>
        {t('note-count', { count: value.length, max: NOTE_MAX })}
      </small>
      <small id={`${id}-help`}>{t('note-help')}</small>
    </div>
  );
}
