'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { readDeliveryOptions } from '../account/customer-api.ts';
import type { CartGroup, CartView, DeliveryChoice } from '../cart/cart.ts';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { SellerLogo } from '../product/seller-logo.tsx';
import { useStore } from '../shell/store-context.tsx';
import type {
  DeliveryMethod,
  DeliveryOptionsAnswer,
  DeliveryWish,
  MethodOption,
  Money,
  QuoteAddress,
  SellerDeliveryOptions,
} from '../storefront/types.ts';
import { deliveryOptionsFor } from './actions.ts';
import {
  clockLabel,
  dayLabel,
  scheduleDays,
  windowLabel,
  windowOf,
  zoneLabel,
} from './schedule.ts';

// The checkout's Delivery method section: one card per seller with the Market's methods (Pickup,
// Instant, Same day, Scheduled). A method the seller or the time rules out is shown disabled with
// the reason; a method the platform switched off is not shown. Prices are the server's stored
// quotes (price plus the platform margin, GST inside); the browser sends the quote id, never a
// price, and the order charges the stored quote when it is placed.

/** A seller's options: `loading` until the server answers, `no-address` until an address is chosen. */
export type OptionsState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'no-address' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'options'; readonly options: SellerDeliveryOptions };

/** Asks for the basket's options: through the session relay when live, the sample action otherwise. */
async function askOptions(
  live: boolean,
  address: QuoteAddress,
  sellerIds: readonly string[],
): Promise<DeliveryOptionsAnswer> {
  if (!live) return deliveryOptionsFor({ address, sellerIds });
  // Only a saved address can be quoted: its stops come from the stored address, never free text.
  if (address.kind !== 'saved') return { kind: 'failed' };
  const result = await readDeliveryOptions(address.id);
  if (result.kind === 'ok') return { kind: 'ok', sellers: result.value };
  return result.kind === 'signed-out' ? { kind: 'signed-out' } : { kind: 'failed' };
}

/**
 * Each seller's delivery options for the address: asked again when the address or the sellers
 * change (an answer for an earlier address is dropped); `retry` asks again. When the connection
 * comes back, a failed answer is asked again. `replace` takes the options Pay found when it
 * checked the prices again.
 */
export function useDeliveryOptions(
  address: QuoteAddress | null,
  sellerIds: readonly string[],
  online: boolean,
  live: boolean,
): {
  readonly states: Readonly<Record<string, OptionsState>>;
  readonly retry: () => void;
  readonly replace: (options: Readonly<Record<string, SellerDeliveryOptions>>) => void;
} {
  const key = address === null ? '' : JSON.stringify([address, sellerIds]);
  const [answer, setAnswer] = useState<{
    readonly key: string;
    readonly got: DeliveryOptionsAnswer;
  }>({ key: '', got: { kind: 'failed' } });
  const latest = useRef(key);
  latest.current = key;

  const ask = useCallback(
    (askKey: string, where: QuoteAddress, ids: readonly string[]) => {
      const settle = (got: DeliveryOptionsAnswer) => {
        if (latest.current === askKey) setAnswer({ key: askKey, got });
      };
      askOptions(live, where, ids).then(settle, () => settle({ kind: 'failed' }));
    },
    [live],
  );

  useEffect(() => {
    if (address === null || key === '') return;
    ask(key, address, sellerIds);
    // `key` holds the address and the sellers: asked again only when one of them changes.
  }, [key, ask]);

  const retry = useCallback(() => {
    if (address === null) return;
    setAnswer({ key: '', got: { kind: 'failed' } });
    ask(key, address, sellerIds);
  }, [address, key, sellerIds, ask]);

  const replace = useCallback(
    (options: Readonly<Record<string, SellerDeliveryOptions>>) =>
      setAnswer((current) =>
        current.key === key && current.got.kind === 'ok'
          ? { key, got: { kind: 'ok', sellers: { ...current.got.sellers, ...options } } }
          : { key, got: { kind: 'ok', sellers: options } },
      ),
    [key],
  );

  const states: Record<string, OptionsState> = {};
  for (const id of sellerIds) {
    if (address === null) states[id] = { kind: 'no-address' };
    else if (answer.key !== key) states[id] = { kind: 'loading' };
    else if (answer.got.kind !== 'ok') states[id] = { kind: 'failed' };
    else {
      const options = Object.hasOwn(answer.got.sellers, id) ? answer.got.sellers[id] : undefined;
      states[id] = options ? { kind: 'options', options } : { kind: 'failed' };
    }
  }

  // Back online: a failed answer is asked again.
  const failed = sellerIds.some((id) => states[id]?.kind === 'failed');
  const wasOnline = useRef(online);
  useEffect(() => {
    const back = online && !wasOnline.current;
    wasOnline.current = online;
    if (back && failed) retry();
  }, [online, failed, retry]);

  return { states, retry, replace };
}

/** The days and windows a seller's scheduled delivery can be picked for, now. */
export function scheduleOf(options: SellerDeliveryOptions, now: Date) {
  return scheduleDays(
    {
      zone: options.zone,
      daysAhead: options.scheduledDaysAhead,
      windowMinutes: options.scheduledWindowMinutes,
    },
    now,
  );
}

/**
 * The delivery each seller gets from the buyer's pick, or nothing for a seller without a valid
 * one: a method that is open and priced (a scheduled one also needs a window still ahead). The
 * price shown is the server's quote; the order charges the stored quote by its id.
 */
export function deliveryChoices(
  sellerIds: readonly string[],
  wishes: Readonly<Record<string, DeliveryWish>>,
  states: Readonly<Record<string, OptionsState>>,
  now: Date,
  currency: string,
): Record<string, DeliveryChoice> {
  const choices: Record<string, DeliveryChoice> = {};
  for (const id of sellerIds) {
    const state = states[id];
    const wish = Object.hasOwn(wishes, id) ? wishes[id] : undefined;
    if (state?.kind !== 'options' || wish === undefined) continue;
    const option = state.options.methods.find((m) => m.method === wish.method);
    if (!option?.available || option.price === null) continue;
    if (option.price.state === 'free') {
      const zero: Money = { amount: 0, currency };
      choices[id] = { method: wish.method, quoteId: null, total: zero, tax: zero, window: null };
    } else if (option.price.state === 'quoted') {
      const { quoteId, total, tax } = option.price;
      if (wish.method === 'scheduled') {
        const picked = scheduleOf(state.options, now)
          .find((d) => d.day === wish.day)
          ?.starts.find((start) => start === wish.windowStart);
        if (wish.day === undefined || picked === undefined) continue;
        const window = windowOf(
          {
            zone: state.options.zone,
            daysAhead: state.options.scheduledDaysAhead,
            windowMinutes: state.options.scheduledWindowMinutes,
          },
          wish.day,
          picked,
        );
        choices[id] = { method: wish.method, quoteId, total, tax, window };
      } else choices[id] = { method: wish.method, quoteId, total, tax, window: null };
    }
  }
  return choices;
}

/**
 * Where the delivery stands for Pay: `ok`; still `loading`; a `problem` (an answer failed, or a
 * seller's chosen method cannot be priced); or `choose` (a seller has no delivery picked yet).
 */
export function deliveryStatus(
  sellerIds: readonly string[],
  states: Readonly<Record<string, OptionsState>>,
  choices: Readonly<Record<string, DeliveryChoice>>,
): 'ok' | 'loading' | 'problem' | 'choose' {
  const all = sellerIds.map((id) => states[id]);
  if (all.some((s) => s?.kind === 'failed')) return 'problem';
  if (all.some((s) => s === undefined || s.kind === 'loading' || s.kind === 'no-address'))
    return 'loading';
  return sellerIds.every((id) => Object.hasOwn(choices, id)) ? 'ok' : 'choose';
}

const METHOD_KEY = {
  pickup: 'pickup',
  instant: 'instant',
  same_day: 'same-day',
  scheduled: 'scheduled',
} as const satisfies Record<DeliveryMethod, string>;

export function DeliverySection({
  view,
  states,
  onRetry,
}: {
  readonly view: CartView;
  readonly states: Readonly<Record<string, OptionsState>>;
  readonly onRetry: () => void;
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
          state={states[g.seller.id] ?? { kind: 'loading' }}
          onRetry={onRetry}
        />
      ))}
    </section>
  );
}

function DeliveryCard({
  group,
  state,
  onRetry,
}: {
  readonly group: CartGroup;
  readonly state: OptionsState;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('checkout');
  const tcart = useTranslations('cart');
  const locale = useLocale();
  const { deliveryWish, setDeliveryWish } = useStore();
  const { seller } = group;
  const money = (m: Money) => formatMoney(m, locale);
  const unpriced =
    state.kind === 'options' &&
    state.options.methods.some(
      (m) => m.available && (m.price?.state === 'failed' || m.price?.state === 'no-fleet'),
    );
  const wish = Object.hasOwn(deliveryWish, seller.id) ? deliveryWish[seller.id] : undefined;
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
      {state.kind === 'failed' ? (
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
      ) : state.kind === 'no-address' ? (
        <p className="dhint">{t('methods-no-address')}</p>
      ) : (
        <div
          className="dgrp"
          role="radiogroup"
          aria-label={t('delivery-method-for', { seller: seller.name })}
          aria-busy={state.kind === 'loading' || undefined}
        >
          {state.kind === 'loading' ? (
            <div className="dopt off" aria-hidden="true">
              <span className="dot" />
              <span className="dtx">
                <i className="sk" />
              </span>
            </div>
          ) : (
            state.options.methods.map((option) => (
              <MethodRow
                key={option.method}
                sellerId={seller.id}
                options={state.options}
                option={option}
                checked={wish?.method === option.method}
                onPick={() => setDeliveryWish(seller.id, { method: option.method })}
              />
            ))
          )}
        </div>
      )}
      {state.kind === 'options' && unpriced ? (
        <p className="dhint dunp">
          {t('methods-unpriced')}{' '}
          {state.options.methods.some((m) => m.price?.state === 'failed') ? (
            <button className="lnk" type="button" onClick={onRetry}>
              {t('try-again-short')}
            </button>
          ) : null}
        </p>
      ) : null}
      {state.kind === 'options' && wish?.method === 'scheduled' ? (
        <SchedulePicker
          sellerId={seller.id}
          options={state.options}
          wish={wish}
          onChange={(next) => setDeliveryWish(seller.id, next)}
        />
      ) : null}
      <div className="dnote">
        <SellerNote sellerId={seller.id} sellerName={seller.name} />
      </div>
    </div>
  );
}

/** The detail line under a method's name: why it is off, or what it offers. */
function MethodDetail({
  options,
  option,
}: {
  readonly options: SellerDeliveryOptions;
  readonly option: MethodOption;
}) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  if (!option.available) {
    switch (option.reason) {
      case 'past-cut-off':
        return (
          <>
            {t('reason-past-cut-off', {
              time: clockLabel(options.sameDayCutoff, locale),
              zone: zoneLabel(options.zone, locale),
            })}
          </>
        );
      case 'no-pickup-address':
        return <>{t('reason-no-pickup-address')}</>;
      default:
        return (
          <>{t('reason-seller-unsupported', { method: t(`kind-${METHOD_KEY[option.method]}`) })}</>
        );
    }
  }
  const price = option.price;
  if (price?.state === 'no-fleet') return <>{t('detail-no-fleet')}</>;
  if (price?.state === 'failed') return <>{t('detail-failed')}</>;
  if (option.method === 'pickup')
    return (
      <>
        {options.pickupPostcode === null
          ? t('detail-pickup')
          : t('detail-pickup-at', { postcode: options.pickupPostcode })}
      </>
    );
  if (option.method === 'instant' && price?.state === 'quoted' && price.etaMinutes !== null)
    return <>{t('detail-instant-eta', { minutes: price.etaMinutes })}</>;
  return <>{t(`detail-${METHOD_KEY[option.method]}`)}</>;
}

/** The cue beside a reason, so a method that is off is not told by colour alone. */
function offIcon(option: MethodOption): 'clock' | 'lock' | 'info' {
  if (!option.available) return option.reason === 'past-cut-off' ? 'clock' : 'lock';
  return 'info';
}

function MethodRow({
  sellerId,
  options,
  option,
  checked,
  onPick,
}: {
  readonly sellerId: string;
  readonly options: SellerDeliveryOptions;
  readonly option: MethodOption;
  readonly checked: boolean;
  readonly onPick: () => void;
}) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  const price = option.price;
  const open = option.available && (price?.state === 'free' || price?.state === 'quoted');
  const detailId = useId();
  return (
    <label className={open ? 'dopt' : 'dopt off'}>
      <input
        type="radio"
        name={`method-${sellerId}`}
        checked={open && checked}
        aria-disabled={open ? undefined : true}
        aria-describedby={detailId}
        onChange={() => {
          // A method that is off stays focusable so its reason is read; it cannot be picked.
          if (open) onPick();
        }}
      />
      <span className="dot" aria-hidden="true" />
      <span className="dtx">
        <b>{t(`method-${METHOD_KEY[option.method]}`)}</b>
        <small id={detailId}>
          {open ? null : <Icon name={offIcon(option)} />}
          <span>
            <MethodDetail options={options} option={option} />
          </span>
        </small>
      </span>
      <span className="fee num">
        {price?.state === 'free' ? (
          t('price-free')
        ) : price?.state === 'quoted' ? (
          <>
            {formatMoney(price.total, locale)}
            <small className="gstl">{t('incl-gst')}</small>
          </>
        ) : null}
      </span>
    </label>
  );
}

/** The day and window of a scheduled delivery, on the seller's clock. */
function SchedulePicker({
  sellerId,
  options,
  wish,
  onChange,
}: {
  readonly sellerId: string;
  readonly options: SellerDeliveryOptions;
  readonly wish: DeliveryWish;
  readonly onChange: (wish: DeliveryWish) => void;
}) {
  const t = useTranslations('checkout');
  const locale = useLocale();
  const id = useId();
  const [now] = useState(() => new Date());
  const days = useMemo(() => scheduleOf(options, now), [options, now]);
  const day = days.find((d) => d.day === wish.day);
  const zone = zoneLabel(options.zone, locale);
  const hintId = `${id}-hint`;
  return (
    <fieldset className="dsched" data-seller={sellerId} aria-live="polite">
      <legend>{t('schedule-title', { zone })}</legend>
      {days.length === 0 ? (
        <p className="dhint">{t('schedule-none')}</p>
      ) : (
        <div className="dsrow">
          <label htmlFor={`${id}-day`}>
            <span>{t('schedule-day')}</span>
            <select
              id={`${id}-day`}
              value={wish.day ?? ''}
              onChange={(event) => onChange({ method: 'scheduled', day: event.target.value })}
            >
              <option value="" disabled>
                {t('schedule-pick-day')}
              </option>
              {days.map((d) => (
                <option key={d.day} value={d.day}>
                  {dayLabel(d.day, locale)}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor={`${id}-window`}>
            <span>{t('schedule-window')}</span>
            <select
              id={`${id}-window`}
              value={
                wish.windowStart !== undefined && day?.starts.includes(wish.windowStart)
                  ? wish.windowStart
                  : ''
              }
              disabled={day === undefined}
              aria-describedby={day === undefined ? hintId : undefined}
              onChange={(event) =>
                onChange({ method: 'scheduled', day: wish.day, windowStart: event.target.value })
              }
            >
              <option value="" disabled>
                {t('schedule-pick-window')}
              </option>
              {(day?.starts ?? []).map((start) => (
                <option key={start} value={start}>
                  {windowLabel(start, options.scheduledWindowMinutes, locale)}
                </option>
              ))}
            </select>
          </label>
          {day === undefined ? (
            <small className="dhint dwh" id={hintId}>
              {t('schedule-window-hint')}
            </small>
          ) : null}
        </div>
      )}
    </fieldset>
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
