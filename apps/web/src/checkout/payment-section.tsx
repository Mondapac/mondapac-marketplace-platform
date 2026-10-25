'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useId, type ReactNode, type RefObject } from 'react';
import type { CartView } from '../cart/cart.ts';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import type { CardSetup, Money, PaymentMethod } from '../storefront/types.ts';
import { Field } from './address-section.tsx';
import type { CardFieldsState } from './stripe-card.ts';

// The Payment method section of the approved design (cart-a-teal): two tiles, Card (default;
// Visa and Mastercard in Stripe's fields on the page) and Stripe (its hosted page, where Apple Pay
// and Google Pay are offered). Above the tiles, what Pay found when it checked the order again.

/** Why Pay is off, for the line under it; null when the buyer can pay. */
export type PayBlock =
  'address' | 'loading' | 'delivery' | 'choose' | 'offline' | 'stock' | 'card' | null;

/** The stock notice says why Pay is held; both Pay buttons point to it. */
const NOTICE_ID = 'checkout-pay-notice';

/** What the last press of Pay found; nothing was charged in any of these. */
export type PayNotice =
  | {
      readonly kind: 'price-changed';
      readonly changes: readonly {
        readonly seller: string;
        readonly was: Money;
        readonly now: Money;
      }[];
    }
  | {
      readonly kind: 'stock-changed';
      readonly changes: readonly {
        readonly item: string;
        readonly was: number;
        readonly now: number;
      }[];
    }
  | { readonly kind: 'declined' }
  | { readonly kind: 'failed' };

/** The Card tile's fields as the page holds them. */
export interface CardForm {
  readonly setup: CardSetup;
  /** Stripe's frames are mounted into this element. */
  readonly target: RefObject<HTMLDivElement | null>;
  readonly state: CardFieldsState;
  readonly onRetry: () => void;
  readonly name: string;
  readonly onName: (name: string) => void;
  /** Shown once Pay was pressed without a name. */
  readonly nameError: boolean;
}

export function PaymentSection({
  view,
  method,
  onMethod,
  card,
  notice,
  block,
  paying,
  onPay,
  reasonId,
}: {
  readonly view: CartView;
  readonly method: PaymentMethod;
  readonly onMethod: (method: PaymentMethod) => void;
  readonly card: CardForm;
  readonly notice: PayNotice | null;
  readonly block: PayBlock;
  readonly paying: boolean;
  readonly onPay: () => void;
  readonly reasonId: string;
}) {
  const t = useTranslations('checkout');
  const heading = useId();
  return (
    <section className="cks" id="checkout-payment" aria-labelledby={heading}>
      <h2 id={heading} tabIndex={-1}>
        {t('payment-method')}
      </h2>
      {notice && (notice.kind !== 'declined' || method === 'card') ? (
        <Notice notice={notice} />
      ) : null}
      <p className="sr-only" role="status">
        {paying ? t(method === 'card' ? 'paying-card' : 'paying-stripe') : ''}
      </p>
      <div className="ptl" role="radiogroup" aria-label={t('payment-method')} inert={paying}>
        <MethodTile
          value="card"
          method={method}
          onMethod={onMethod}
          icon="card"
          label={t('method-card')}
          note={t('method-card-note')}
        />
        <MethodTile
          value="stripe"
          method={method}
          onMethod={onMethod}
          icon="lock"
          label={t('method-stripe')}
          note={t('method-stripe-note')}
        />
      </div>
      {method === 'card' ? (
        <CardFields card={card} />
      ) : (
        <div className="paybox">
          <div className="payhd">
            <Icon name="lock" />
            {t('pay-title')}
          </div>
          <p>{t('pay-body')}</p>
        </div>
      )}
      <p className="legal ckl">
        <Icon name="info" />
        {t('full-charge')}
      </p>
      <div className="ckpm">
        <PayButton
          view={view}
          method={method}
          block={block}
          paying={paying}
          onPay={onPay}
          reasonId={reasonId}
        />
        {block !== null && block !== 'stock' ? (
          <p className="legal" id={reasonId}>
            {t(`pay-block-${block}-above`)}
          </p>
        ) : null}
        <p className="legal">{t.rich('agree-order', legalLinks)}</p>
      </div>
    </section>
  );
}

export const legalLinks = {
  terms: (chunks: ReactNode) => <Link href="/terms">{chunks}</Link>,
  privacy: (chunks: ReactNode) => <Link href="/privacy">{chunks}</Link>,
};

function MethodTile({
  value,
  method,
  onMethod,
  icon,
  label,
  note,
}: {
  readonly value: PaymentMethod;
  readonly method: PaymentMethod;
  readonly onMethod: (method: PaymentMethod) => void;
  readonly icon: 'card' | 'lock';
  readonly label: string;
  readonly note: string;
}) {
  return (
    <label className="pt">
      <input
        type="radio"
        name="payment-method"
        value={value}
        checked={method === value}
        onChange={() => onMethod(value)}
      />
      <span className="pti">
        <Icon name={icon} />
      </span>
      <b>{label}</b>
      <small>{note}</small>
    </label>
  );
}

/** Stripe's card fields with the name on the card, or the sample's note when no key is set. */
function CardFields({ card }: { readonly card: CardForm }) {
  const t = useTranslations('checkout');
  if (card.setup.kind === 'sample')
    return (
      <div className="cfm">
        <p className="infob">
          <Icon name="info" />
          <span>{t('card-sample')}</span>
        </p>
      </div>
    );
  return (
    <div className="cfm">
      {card.state === 'failed' ? (
        <div className="dwarn2" role="status">
          <Icon name="info" />
          <p>{t('card-load-failed')}</p>
          <span className="dwa">
            <button className="btn ghost sm" type="button" onClick={card.onRetry}>
              {t('try-again-short')}
            </button>
          </span>
        </div>
      ) : null}
      {card.state === 'loading' ? (
        <p className="legal" role="status">
          {t('card-loading')}
        </p>
      ) : null}
      <div ref={card.target} className="sfr" hidden={card.state === 'failed'} />
      <Field
        label={t('card-name')}
        autoComplete="cc-name"
        value={card.name}
        onText={card.onName}
        error={card.nameError && card.name.trim() === '' ? t('card-name-missing') : undefined}
      />
      <p className="legal ckl">
        <Icon name="lock" />
        {t('card-secure')}
      </p>
    </div>
  );
}

function Notice({ notice }: { readonly notice: PayNotice }) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  const b = (chunks: ReactNode) => <b>{chunks}</b>;
  return (
    <div className="dwarn2" role="alert">
      <Icon name="info" />
      {notice.kind === 'price-changed' ? (
        <p>
          <b>{t('notice-price-title')}</b>{' '}
          {notice.changes
            .map((c) =>
              t('notice-price-line', {
                seller: c.seller,
                was: formatMoney(c.was, locale),
                now: formatMoney(c.now, locale),
              }),
            )
            .join(' ')}{' '}
          {t('notice-price-body')}
        </p>
      ) : notice.kind === 'stock-changed' ? (
        <>
          <p id={NOTICE_ID}>
            <b>{t('notice-stock-title')}</b>{' '}
            {notice.changes
              .map((c) =>
                c.now === 0
                  ? t('notice-stock-gone', { item: c.item })
                  : t('notice-stock-line', { item: c.item, was: c.was, now: c.now }),
              )
              .join(' ')}{' '}
            {t('notice-stock-body')}
          </p>
          <span className="dwa">
            <Link className="btn ghost sm" href="/cart">
              {t('review-cart')}
            </Link>
          </span>
        </>
      ) : notice.kind === 'declined' ? (
        <p>{t.rich('notice-declined', { b })}</p>
      ) : (
        <p>{t.rich('notice-failed', { b })}</p>
      )}
    </div>
  );
}

export function PayButton({
  view,
  method,
  block,
  paying,
  onPay,
  className,
  reasonId,
}: {
  readonly view: CartView;
  readonly method: PaymentMethod;
  readonly block: PayBlock;
  readonly paying: boolean;
  readonly onPay: () => void;
  readonly className?: string;
  /** The line under the button that says why it is off. */
  readonly reasonId: string;
}) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  const amount = formatMoney(view.total, locale);
  return (
    <button
      className={className ? `btn wide ${className}` : 'btn wide'}
      type="button"
      data-pay=""
      aria-disabled={block === null && !paying ? undefined : true}
      aria-busy={paying || undefined}
      aria-describedby={block === null ? undefined : block === 'stock' ? NOTICE_ID : reasonId}
      onClick={onPay}
    >
      {paying ? (
        method === 'card' ? (
          t('paying-card')
        ) : (
          t('paying-stripe')
        )
      ) : (
        <>
          <Icon name="lock" />
          {method === 'card' ? t('pay-card', { amount }) : t('pay', { amount })}
        </>
      )}
    </button>
  );
}
