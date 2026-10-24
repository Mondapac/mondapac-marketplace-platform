'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { addressLine as savedLine, recipientName } from '../account/address-line.ts';
import { Icon } from '../icons/icon.tsx';
import type {
  CheckoutPlace,
  CheckoutSource,
  SavedAddress,
  ServiceArea,
} from '../storefront/types.ts';
import { deliveryAreaFor } from './actions.ts';
import { isPostcodeQuery, placeLine, suggestPlaces } from './address-search.ts';

// The checkout's Delivery address section: one row per saved address, or a new address found
// with one search field (postcode or street; a suburb pick narrows to its streets) and confirmed
// against the service area. "Enter it manually" falls back to street, suburb, state and postcode.

/** A new address as the buyer is entering it. */
export interface NewAddress {
  /** `search`: the address search field; `manual`: the separate fields. */
  readonly mode: 'search' | 'manual';
  /** What is typed in the search field. */
  readonly query: string;
  /** The suburb chip: only its streets are listed. */
  readonly suburbPick: CheckoutPlace | null;
  /** The street address picked from the list. */
  readonly picked: CheckoutPlace | null;
  readonly unit: string;
  readonly name: string;
  readonly phone: string;
  readonly street: string;
  readonly suburb: string;
  readonly postcode: string;
  readonly note: string;
}

export const EMPTY_ADDRESS: NewAddress = {
  mode: 'search',
  query: '',
  suburbPick: null,
  picked: null,
  unit: '',
  name: '',
  phone: '',
  street: '',
  suburb: '',
  postcode: '',
  note: '',
};

/** Whether a postcode is in the sample service area (the API answers once API_BASE_URL is set). */
export function inServiceArea(area: ServiceArea, postcode: string): boolean {
  return (
    /^\d+$/.test(postcode) &&
    area.postcodes.some(
      (r) => postcode.length === r.from.length && postcode >= r.from && postcode <= r.to,
    )
  );
}

/** Where a postcode stands: `checking` while the API has not answered. */
export type AreaState = 'in' | 'out' | 'checking' | 'failed';

/** Shortest postcode worth asking about (an AU postcode has four digits). */
export const AREA_CHECK_MIN = 4;

/**
 * The delivery area answer for a postcode: the sample list in the browser, or the API's answer
 * (one read per postcode, the last one wins).
 */
export function useDeliveryArea(source: CheckoutSource, postcode: string): AreaState {
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
  if (!api) return inServiceArea(source.serviceArea, value) ? 'in' : 'out';
  if (value.length < AREA_CHECK_MIN) return 'out';
  return answer?.postcode === value ? answer.state : 'checking';
}

/** The postcode a new address is delivered to, as far as it is known. */
export function newPostcode(fresh: NewAddress): string {
  return fresh.mode === 'manual' ? fresh.postcode.trim() : (fresh.picked?.postcode ?? '');
}

/** Whether the new address is complete (the delivery area answer comes separately). */
export function newAddressComplete(fresh: NewAddress): boolean {
  const named = fresh.name.trim() !== '' && fresh.phone.trim() !== '';
  if (fresh.mode === 'search') return named && fresh.picked !== null;
  return named && fresh.street.trim() !== '' && fresh.suburb.trim() !== '';
}

/** The new address as one line ("Unit 3/12 Example Street, Kedron QLD 4031"). */
export function newAddressLine(fresh: NewAddress, area: ServiceArea, fallback: string): string {
  if (fresh.mode === 'search' && fresh.picked) {
    const unit = fresh.unit.trim();
    return `${unit ? `${unit}/` : ''}${placeLine(fresh.picked)}`;
  }
  return [
    fresh.street.trim() || fallback,
    fresh.suburb.trim(),
    fresh.postcode.trim() && `${area.regionCode} ${fresh.postcode.trim()}`,
  ]
    .filter(Boolean)
    .join(', ');
}

export function AddressSection({
  source,
  addresses,
  choice,
  onChoice,
  fresh,
  onFresh,
  areaState,
}: {
  readonly source: CheckoutSource;
  readonly addresses: readonly SavedAddress[];
  /** A saved address id, or `new`. */
  readonly choice: string;
  readonly onChoice: (choice: string) => void;
  readonly fresh: NewAddress;
  readonly onFresh: (fresh: NewAddress) => void;
  /** The delivery area answer for the new address's postcode. */
  readonly areaState: AreaState;
}) {
  const t = useTranslations('checkout');
  const area = source.serviceArea;
  const heading = useId();
  const isNew = !addresses.some((a) => a.id === choice);
  return (
    <section className="cks" id="checkout-address" aria-labelledby={heading}>
      <h2 id={heading} tabIndex={-1}>
        {t('address')}
      </h2>
      <div className="adg" role="radiogroup" aria-label={t('address')}>
        {addresses.map((a) => (
          <label className="aopt" key={a.id}>
            <input
              type="radio"
              name="address"
              value={a.id}
              checked={choice === a.id}
              onChange={() => onChoice(a.id)}
            />
            <b>
              {recipientName(a)}
              {a.isDefault ? <span className="badge">{t('default')}</span> : null}
            </b>
            <span>{savedLine(a, source.serviceArea.regionCode)}</span>
            <span>{a.phone}</span>
          </label>
        ))}
        <label className="aopt">
          <input
            type="radio"
            name="address"
            value="new"
            checked={isNew}
            onChange={() => onChoice('new')}
          />
          <b>{t('new-address')}</b>
          <span>{t('new-address-note', { area: area.name })}</span>
        </label>
      </div>
      {isNew ? (
        <NewAddressForm source={source} value={fresh} onChange={onFresh} areaState={areaState} />
      ) : null}
    </section>
  );
}

function NewAddressForm({
  source,
  value,
  onChange,
  areaState,
}: {
  readonly source: CheckoutSource;
  readonly value: NewAddress;
  readonly onChange: (value: NewAddress) => void;
  readonly areaState: AreaState;
}) {
  const t = useTranslations('checkout');
  const area = source.serviceArea;
  const set = (key: 'unit' | 'name' | 'phone' | 'street' | 'suburb' | 'postcode' | 'note') => {
    return (text: string) => onChange({ ...value, [key]: text });
  };
  const noteId = useId();
  // After "Change" on a picked address the search comes back with the focus in it.
  const [searchAgain, setSearchAgain] = useState(false);
  const nameField = (
    <Field label={t('full-name')} autoComplete="name" value={value.name} onText={set('name')} />
  );
  const phoneField = (
    <Field
      label={t('mobile')}
      type="tel"
      autoComplete="tel"
      inputMode="tel"
      hint={t('mobile-hint')}
      value={value.phone}
      onText={set('phone')}
    />
  );
  return (
    <>
      {value.mode === 'search' ? (
        <>
          {value.picked ? (
            <PickedAddress
              place={value.picked}
              areaState={areaState}
              area={area}
              onChange={() => {
                setSearchAgain(true);
                onChange({ ...value, picked: null, suburbPick: null, query: '' });
              }}
            />
          ) : (
            <AddressSearch
              source={source}
              value={value}
              onChange={onChange}
              focusOnShow={searchAgain}
            />
          )}
          <div className="frow two">
            <Field
              label={t('unit')}
              autoComplete="address-line2"
              value={value.unit}
              onText={set('unit')}
              focusKey={value.picked?.id}
            />
            {phoneField}
          </div>
          {nameField}
        </>
      ) : (
        <ManualAddress
          area={area}
          areaState={areaState}
          value={value}
          onChange={onChange}
          nameField={nameField}
          phoneField={phoneField}
        />
      )}
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

/** The confirmed row of a picked address: "We deliver here" once the area check says so. */
function PickedAddress({
  place,
  areaState,
  area,
  onChange,
}: {
  readonly place: CheckoutPlace;
  readonly areaState: AreaState;
  readonly area: ServiceArea;
  readonly onChange: () => void;
}) {
  const t = useTranslations('checkout');
  const problem =
    areaState === 'out'
      ? t('outside-area', { postcode: place.postcode, area: area.name })
      : areaState === 'failed'
        ? t('area-check-failed')
        : null;
  return (
    <div className="fld">
      <div className={problem ? 'acsel bad' : 'acsel'}>
        <Icon name="pin" />
        <div>
          <b>{place.street}</b>
          <small>
            {place.suburb} {place.regionCode} {place.postcode}
          </small>
        </div>
        {areaState === 'in' ? (
          <span className="acok">
            <Icon name="check" />
            {t('we-deliver-here')}
          </span>
        ) : null}
        <button
          className="lnk"
          type="button"
          aria-label={t('change-address-search')}
          onClick={onChange}
        >
          {t('change')}
        </button>
      </div>
      {problem ? (
        <span className="err" role="alert">
          {problem}
        </span>
      ) : null}
    </div>
  );
}

/**
 * The address search: a combobox with a listbox of suburbs and addresses (arrows move, Enter
 * picks, Esc closes the list and a second Esc clears; leaving the field closes it too). A full
 * postcode outside the service area, or no match, is said on a status line below the field.
 */
function AddressSearch({
  source,
  value,
  onChange,
  focusOnShow,
}: {
  readonly source: CheckoutSource;
  readonly value: NewAddress;
  readonly onChange: (value: NewAddress) => void;
  readonly focusOnShow: boolean;
}) {
  const t = useTranslations('checkout');
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [active, setActive] = useState(-1);
  const [closed, setClosed] = useState(false);
  const area = source.serviceArea;
  const query = value.query.trim();
  const list = suggestPlaces(source.places, value.query, value.suburbPick);
  const typedPostcode = value.suburbPick === null && isPostcodeQuery(query) ? query : '';
  const postcodeArea = useDeliveryArea(source, typedPostcode);
  const outside = typedPostcode.length >= AREA_CHECK_MIN && postcodeArea === 'out';
  const typed = query !== '' || value.suburbPick !== null;
  const shown = outside || closed || !typed ? [] : list;
  const expanded = shown.length > 0;
  const status = !typed
    ? null
    : outside
      ? 'outside'
      : list.length === 0 && query !== ''
        ? 'none'
        : null;
  const focusInput = () => setTimeout(() => input.current?.focus(), 0);
  useEffect(() => {
    if (focusOnShow) input.current?.focus();
  }, [focusOnShow]);

  const pick = (place: CheckoutPlace) => {
    setActive(-1);
    setClosed(false);
    if (place.street === '') {
      onChange({ ...value, suburbPick: place, query: '' });
      focusInput();
    } else onChange({ ...value, picked: place, suburbPick: null, query: '' });
  };
  const onKey = (event: KeyboardEvent<HTMLInputElement>) => {
    const n = shown.length;
    if (event.key === 'ArrowDown' && n > 0) {
      event.preventDefault();
      setActive((i) => (i + 1) % n);
    } else if (event.key === 'ArrowUp' && n > 0) {
      event.preventDefault();
      setActive((i) => (i <= 0 ? n : i) - 1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = shown[active >= 0 ? active : n === 1 ? 0 : -1];
      if (chosen) pick(chosen);
    } else if (event.key === 'Escape') {
      setActive(-1);
      if (expanded) setClosed(true);
      else onChange({ ...value, query: '' });
    }
  };
  return (
    <div className="fld ac">
      <label htmlFor={id}>{t('address-search')}</label>
      {value.suburbPick ? (
        <div className="acchip">
          <span>
            <Icon name="pin" />
            {placeLine(value.suburbPick)}
          </span>
          <button
            className="lnk"
            type="button"
            aria-label={t('change-suburb')}
            onClick={() => {
              onChange({ ...value, suburbPick: null, query: '' });
              focusInput();
            }}
          >
            {t('change')}
          </button>
        </div>
      ) : null}
      <div className="acw">
        <input
          id={id}
          ref={input}
          role="combobox"
          aria-expanded={expanded}
          aria-controls={`${id}-list`}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 && shown[active] ? `${id}-o${active}` : undefined}
          aria-describedby={`${id}-help`}
          autoComplete="off"
          placeholder={value.suburbPick ? t('search-street') : t('search-placeholder')}
          value={value.query}
          onChange={(event) => {
            setActive(-1);
            setClosed(false);
            onChange({ ...value, query: event.target.value });
          }}
          onKeyDown={onKey}
          onBlur={() => {
            setActive(-1);
            setClosed(true);
          }}
          onFocus={() => setClosed(false)}
        />
        <ul className="aclist" id={`${id}-list`} role="listbox" aria-label={t('suggestions')}>
          {shown.map((place, i) => (
            <li
              key={place.id}
              id={`${id}-o${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'on' : undefined}
              // Keep the focus in the field: the click picks without blurring it first.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => pick(place)}
            >
              <Icon name="pin" />
              {place.street === '' ? (
                <span>
                  <b>{place.suburb}</b> {place.regionCode} {place.postcode}
                  <small>{t('suburb-then-street')}</small>
                </span>
              ) : (
                <span>
                  <b>{place.street}</b>, {place.suburb} {place.regionCode} {place.postcode}
                </span>
              )}
            </li>
          ))}
        </ul>
      </div>
      <p className="acst" role="status">
        {status === 'outside' ? (
          t('outside-area', { postcode: typedPostcode, area: area.name })
        ) : status === 'none' ? (
          <>
            {t('no-addresses')}{' '}
            <button
              className="lnk"
              type="button"
              onClick={() => onChange({ ...value, mode: 'manual' })}
            >
              {t('enter-manually')}
            </button>
          </>
        ) : null}
      </p>
      <small id={`${id}-help`}>{t('search-hint')}</small>
      <button
        className="lnk acm"
        type="button"
        onClick={() => onChange({ ...value, mode: 'manual' })}
      >
        {t('enter-address-manually')}
      </button>
    </div>
  );
}

/** The fallback fields when the search has no match: street, suburb, state (fixed), postcode. */
function ManualAddress({
  area,
  areaState,
  value,
  onChange,
  nameField,
  phoneField,
}: {
  readonly area: ServiceArea;
  readonly areaState: AreaState;
  readonly value: NewAddress;
  readonly onChange: (value: NewAddress) => void;
  readonly nameField: ReactNode;
  readonly phoneField: ReactNode;
}) {
  const t = useTranslations('checkout');
  // The postcode error shows once four digits are typed, or when the field is left too short.
  const [left, setLeft] = useState(false);
  const postcode = value.postcode;
  const shown = postcode.length >= AREA_CHECK_MIN || (left && postcode !== '');
  const error = !shown
    ? undefined
    : areaState === 'out'
      ? t('outside-area', { postcode, area: area.name })
      : areaState === 'failed'
        ? t('area-check-failed')
        : undefined;
  const set = (key: 'street' | 'suburb' | 'postcode') => (text: string) =>
    onChange({ ...value, [key]: text });
  return (
    <>
      <div className="frow two">
        {nameField}
        {phoneField}
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
          value={postcode}
          onText={(text) => {
            setLeft(false);
            set('postcode')(text);
          }}
          onLeave={() => setLeft(true)}
          error={error}
        />
      </div>
      <button
        className="lnk acm"
        type="button"
        onClick={() => onChange({ ...value, mode: 'search' })}
      >
        {t('search-instead')}
      </button>
    </>
  );
}

export function Field({
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
  focusKey,
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
  /** The field takes the focus when this changes to a value (the next field after a pick). */
  readonly focusKey?: string | undefined;
}) {
  const id = useId();
  const help = error ?? hint;
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focusKey !== undefined) ref.current?.focus();
  }, [focusKey]);
  return (
    <div className={error ? 'fld bad' : 'fld'}>
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        ref={ref}
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
