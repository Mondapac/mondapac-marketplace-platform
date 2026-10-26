'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CartGroup, CartView, DeliveryChoice } from '../cart/cart.ts';
import { formatMoney } from '../format/money.ts';
import { intlLocale } from '../i18n/locale.ts';
import { Icon } from '../icons/icon.tsx';
import { SellerLogo } from '../product/seller-logo.tsx';
import { useStore } from '../shell/store-context.tsx';
import type {
  DeliveryQuote,
  DeliverySpeed,
  ExpressTerms,
  Money,
  QuoteAddress,
} from '../storefront/types.ts';
import { deliveryQuotesFor } from './actions.ts';

// The checkout's Delivery method section: one card per seller with Scheduled (the seller's window
// and flat fee) and Express (within 2 hours once the seller has the order ready, at the courier's
// live price) side by side. Scheduled is the default. Express is offered only while the courier
// quotes a price for it; the order checks every price again when it is placed.

/**
 * A seller's quote: `loading` while the courier has not answered, `no-address` until an address
 * is chosen.
 */
export type QuoteState =
  DeliveryQuote | { readonly kind: 'loading' } | { readonly kind: 'no-address' };

/**
 * Each seller's delivery quote for the address: asked again when the address or the sellers
 * change (an answer for an earlier address is dropped); `retry` asks again for one seller. When
 * the connection comes back, the sellers whose quote failed are asked again. `replace` takes the
 * quotes Pay found when it checked the prices again.
 */
export function useDeliveryQuotes(
  address: QuoteAddress | null,
  sellerIds: readonly string[],
  online: boolean,
): {
  readonly quotes: Readonly<Record<string, QuoteState>>;
  readonly retry: (id: string) => void;
  readonly replace: (quotes: Readonly<Record<string, DeliveryQuote>>) => void;
} {
  const key = address === null ? '' : JSON.stringify([address, sellerIds]);
  const [answers, setAnswers] = useState<{
    readonly key: string;
    readonly quotes: Readonly<Record<string, QuoteState>>;
  }>({ key: '', quotes: {} });
  const latest = useRef(key);
  latest.current = key;

  const ask = useCallback((askKey: string, request: QuoteAddress, ids: readonly string[]) => {
    const settle = (got: Readonly<Record<string, DeliveryQuote>>) => {
      if (latest.current !== askKey) return;
      setAnswers((current) => {
        const quotes = { ...(current.key === askKey ? current.quotes : {}) };
        for (const id of ids) quotes[id] = got[id] ?? { kind: 'failed' };
        return { key: askKey, quotes };
      });
    };
    deliveryQuotesFor({ address: request, sellerIds: ids }).then(settle, () => settle({}));
  }, []);

  useEffect(() => {
    if (address === null || key === '') return;
    ask(key, address, sellerIds);
    // `key` holds the address and the sellers: asked again only when one of them changes.
  }, [key, ask]);

  const retry = useCallback(
    (id: string) => {
      if (address === null) return;
      setAnswers((current) =>
        current.key === key
          ? { key, quotes: { ...current.quotes, [id]: { kind: 'loading' } } }
          : current,
      );
      ask(key, address, [id]);
    },
    [address, key, ask],
  );

  const replace = useCallback(
    (fresh: Readonly<Record<string, DeliveryQuote>>) =>
      setAnswers((current) =>
        current.key === key ? { key, quotes: { ...current.quotes, ...fresh } } : current,
      ),
    [key],
  );

  const quotes: Record<string, QuoteState> = {};
  for (const id of sellerIds)
    quotes[id] =
      address === null
        ? { kind: 'no-address' }
        : ((answers.key === key ? answers.quotes[id] : undefined) ?? { kind: 'loading' });

  // Back online: the quotes that failed meanwhile are asked again.
  const failed = sellerIds.filter((id) => quotes[id]?.kind === 'failed').join(' ');
  const wasOnline = useRef(online);
  useEffect(() => {
    const back = online && !wasOnline.current;
    wasOnline.current = online;
    if (back && failed !== '') for (const id of failed.split(' ')) retry(id);
  }, [online, failed, retry]);

  return { quotes, retry, replace };
}

/** The Express price a quote gives, or null: Express is offered only with a price. */
export function expressPrice(quote: QuoteState | undefined): Money | null {
  return quote?.kind === 'quote' ? quote.express : null;
}

/**
 * The delivery each seller gets: Express at the quoted price when the buyer picked it and the
 * courier prices it now; Scheduled otherwise (the buyer's pick is kept for when a price comes).
 */
export function deliveryChoices(
  sellerIds: readonly string[],
  wishes: Readonly<Record<string, DeliverySpeed>>,
  quotes: Readonly<Record<string, QuoteState>>,
): Record<string, DeliveryChoice> {
  const choices: Record<string, DeliveryChoice> = {};
  for (const id of sellerIds) {
    const price = expressPrice(quotes[id]);
    choices[id] =
      wishes[id] === 'express' && price !== null
        ? { speed: 'express', fee: price }
        : { speed: 'scheduled' };
  }
  return choices;
}

/** Where the delivery choices stand for Pay: `ok`, still `loading`, or a `problem` to fix. */
export function quotesReady(
  quotes: Readonly<Record<string, QuoteState>>,
): 'ok' | 'loading' | 'problem' {
  const states = Object.values(quotes);
  if (states.some((q) => q.kind === 'failed' || q.kind === 'out-of-range')) return 'problem';
  if (states.some((q) => q.kind === 'loading' || q.kind === 'no-address')) return 'loading';
  return 'ok';
}

export function DeliverySection({
  view,
  quotes,
  onRetry,
  onChangeAddress,
  addressLine,
}: {
  readonly view: CartView;
  readonly quotes: Readonly<Record<string, QuoteState>>;
  readonly onRetry: (sellerId: string) => void;
  /** Moves the focus to the address section (Change address). */
  readonly onChangeAddress: () => void;
  /** The chosen address without its label, for the out-of-range message. */
  readonly addressLine: string;
}) {
  const t = useTranslations('checkout');
  const heading = useId();
  return (
    <section className="cks" aria-labelledby={heading}>
      <h2 id={heading}>{t('delivery-method')}</h2>
      <div className="infob">
        <Icon name="truck" />
        <span>{t('delivery-method-note')}</span>
      </div>
      {view.groups.map((g) => (
        <DeliveryCard
          key={g.seller.id}
          group={g}
          quote={quotes[g.seller.id] ?? { kind: 'loading' }}
          onRetry={() => onRetry(g.seller.id)}
          onChangeAddress={onChangeAddress}
          addressLine={addressLine}
        />
      ))}
    </section>
  );
}

function DeliveryCard({
  group,
  quote,
  onRetry,
  onChangeAddress,
  addressLine,
}: {
  readonly group: CartGroup;
  readonly quote: QuoteState;
  readonly onRetry: () => void;
  readonly onChangeAddress: () => void;
  readonly addressLine: string;
}) {
  const t = useTranslations('checkout');
  const tcart = useTranslations('cart');
  const locale = useLocale();
  const { setDeliveryWish } = useStore();
  const { seller } = group;
  const money = (m: CartView['total']) => formatMoney(m, locale);
  const express = expressPrice(quote);
  const loading = quote.kind === 'loading';
  return (
    <div className="dcard">
      <header>
        <SellerLogo logo={seller.logo} />
        <div>
          <b>{seller.name}</b>
          <small>
            {tcart('items', { count: group.count })} · {money(group.subtotal)}
          </small>
        </div>
      </header>
      {quote.kind === 'out-of-range' ? (
        <div className="dwarn2" role="alert">
          <Icon name="info" />
          <p>
            <b>{t('out-of-range-title')}</b> {t('out-of-range-body', { address: addressLine })}
          </p>
          <span className="dwa">
            <button className="lnk" type="button" onClick={onChangeAddress}>
              {t('change-address')}
            </button>
            <Link className="lnk" href="/cart">
              {t('back-to-cart')}
            </Link>
          </span>
        </div>
      ) : quote.kind === 'failed' ? (
        <div className="dwarn2" role="alert">
          <Icon name="info" />
          <p>
            <b>{t('quote-failed-title')}</b> {t('quote-failed-body')}
          </p>
          <span className="dwa">
            <button className="btn ghost small" type="button" onClick={onRetry}>
              {t('try-again-short')}
            </button>
          </span>
        </div>
      ) : (
        <div
          className="dgrp"
          role="radiogroup"
          aria-label={t('delivery-speed-for', { seller: seller.name })}
          aria-busy={loading || undefined}
        >
          <SpeedOption
            name={`speed-${seller.id}`}
            checked={group.speed === 'scheduled'}
            title={t('scheduled')}
            detail={seller.deliveryWindow}
            fee={money(seller.deliveryFee)}
            onPick={() => setDeliveryWish(seller.id, 'scheduled')}
          />
          {express || loading ? (
            <SpeedOption
              name={`speed-${seller.id}`}
              checked={group.speed === 'express'}
              title={t('express')}
              tag={t('fastest')}
              detail={t('express-detail')}
              fee={express ? money(express) : null}
              disabled={!express}
              onPick={() => {
                if (express) setDeliveryWish(seller.id, 'express');
              }}
            />
          ) : (
            <div className="dopt off" aria-disabled="true">
              <span className="dot" aria-hidden="true" />
              <span className="dtx">
                <b>{t('express')}</b>
                <small>
                  {quote.kind === 'no-address' ? (
                    t('express-no-address')
                  ) : (
                    <>
                      {t('express-off')} <ExpressReason terms={seller.express} />
                    </>
                  )}
                </small>
              </span>
            </div>
          )}
        </div>
      )}
      <div className="dnote">
        <SellerNote sellerId={seller.id} sellerName={seller.name} />
      </div>
    </div>
  );
}

/** Why Express is off for a seller: it does not offer it, or today's cut-off has passed. */
function ExpressReason({ terms }: { readonly terms: ExpressTerms | undefined }) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  if (terms?.kind !== 'closed') return <>{t('express-not-offered')}</>;
  const at = new Date(terms.cutoff);
  const zoned = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: terms.timeZone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const minute = zoned.formatToParts(at).find((p) => p.type === 'minute')?.value;
  const time = new Intl.DateTimeFormat(intlLocale(locale), {
    timeZone: terms.timeZone,
    hour: 'numeric',
    ...(minute === '00' ? {} : { minute: '2-digit' }),
  }).format(at);
  // "Australia/Brisbane" reads "Brisbane".
  const zone = terms.timeZone.split('/').pop()!.replaceAll('_', ' ');
  return <>{t('express-closed', { time, zone })}</>;
}

function SpeedOption({
  name,
  checked,
  title,
  tag,
  detail,
  fee,
  disabled = false,
  onPick,
}: {
  readonly name: string;
  readonly checked: boolean;
  readonly title: string;
  readonly tag?: string;
  readonly detail: string;
  /** Null while the courier's price is loading. */
  readonly fee: string | null;
  readonly disabled?: boolean;
  readonly onPick: () => void;
}) {
  return (
    <label className="dopt">
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onPick} />
      <span className="dot" aria-hidden="true" />
      <span className="dtx">
        <b>
          {title}
          {tag ? <em className="dtag">{tag}</em> : null}
        </b>
        <small>{detail}</small>
      </span>
      <span className="fee num">{fee ?? <i className="sk" aria-hidden="true" />}</span>
    </label>
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
