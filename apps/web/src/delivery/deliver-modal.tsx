'use client';

import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { addressLine as savedLine, recipientName } from '../account/address-line.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { DeliveryLocatorSource, GeoPoint, Place } from '../storefront/types.ts';
import { saveDeliverTo } from './deliver-to.ts';
import { addressLine, insideArea, locality } from './geo.ts';
import { deliveryAreaFor } from '../checkout/actions.ts';
import { SearchProblem, liveLookup, sampleLookup } from './lookup.ts';
import { MIN_QUERY } from './mapbox.ts';
import { DeliveryMap } from './delivery-map.tsx';
import { writeAddressPrefill } from './address-prefill.ts';

/** How the pin got where it is: an address picked, the pin moved, or the device location. */
type Origin = 'place' | 'pin' | 'device';

interface Pick {
  readonly point: GeoPoint;
  readonly origin: Origin;
  /** The address picked, or the suburb found at the pin or device location. */
  readonly place: Place | null;
  /** The saved address chosen, when the pick came from the address book. */
  readonly savedId?: string;
  /** The lookup has not yet answered for this point; `place` is still the one before. */
  readonly pending?: boolean;
}

type Locating = 'idle' | 'busy' | 'blocked' | 'failed';

const NARROW = '(max-width: 760px)';

/**
 * The Deliver to modal of the header button (approved design deliver-to-a-teal.html v3). From
 * 761px a centred dialog (controls left, map right); narrower, a full-screen sheet with the map on
 * top and a sticky footer. The buyer searches an address, uses the device location (asked for
 * only on tap), picks a saved address when signed in, or moves the pin. Confirm (only inside the
 * delivery area) sets the header's "<suburb> <postcode>" and refreshes the page. With the live
 * lookup (`source.live`) addresses and suburbs come from Mapbox through the buyer site's own
 * routes and "We deliver to this area" from the API's delivery area for the postcode; otherwise
 * both are stubs on sample data. The map is still the stub until its provider PR.
 */
export function DeliverModal({ source }: { readonly source: DeliveryLocatorSource }) {
  const t = useTranslations('deliver');
  const router = useRouter();
  const {
    deliverOpen: open,
    setDeliverOpen,
    deliverTo,
    setDeliverTo,
    deliverGuess,
    customer,
    setLoginOpen,
  } = useStore();
  const lookup = useMemo(
    () =>
      source.live
        ? liveLookup({ fetch: (input, init) => fetch(input, init), area: deliveryAreaFor })
        : sampleLookup(source),
    [source],
  );
  /** The API's answer for the last postcode asked (live lookup only). */
  const [areaAnswer, setAreaAnswer] = useState<{
    readonly postcode: string;
    readonly delivers: boolean | null;
  } | null>(null);
  const [mounted, setMounted] = useState(false);
  const [pick, setPick] = useState<Pick>({
    point: source.start.point,
    origin: 'place',
    place: source.start,
  });
  const [query, setQuery] = useState('');
  /** The suggestions shown; null while the list is closed. */
  const [results, setResults] = useState<readonly Place[] | null>(null);
  const [active, setActive] = useState(-1);
  const [locating, setLocating] = useState<Locating>('idle');
  /** Why the live search shows no list: typed too little, too many searches, or it failed. */
  const [searchNote, setSearchNote] = useState<'short' | SearchProblem['kind'] | null>(null);
  /** A search is waiting for its answer (the list keeps the last results meanwhile). */
  const [searching, setSearching] = useState(false);
  /** A saved address could not be looked up; shown under the saved addresses. */
  const [savedFailed, setSavedFailed] = useState(false);
  /** "Save to my addresses": asking for the storable answer, or it failed. */
  const [keeping, setKeeping] = useState<'idle' | 'busy' | 'failed'>('idle');
  const confirmed = useRef<Pick | null>(null);
  /** The pick made from the guessed area on opening; the guess note shows while it stands. */
  const guessPick = useRef<Pick | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef<Element | null>(null);
  const openNow = useRef(open);
  const searchTicket = useRef(0);
  const placeTicket = useRef(0);
  const ids = useId();
  const titleId = `${ids}-title`;
  const listId = `${ids}-list`;
  const optionId = (i: number) => `${ids}-o${i}`;

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    openNow.current = open;
    if (!open) return;
    // A click does not focus the button in every browser (Safari): fall back to the header's.
    opener.current =
      document.activeElement && document.activeElement !== document.body
        ? document.activeElement
        : document.querySelector('.top .deliver');
    setQuery('');
    setResults(null);
    setActive(-1);
    setLocating('idle');
    setSearchNote(null);
    setSearching(false);
    setSavedFailed(false);
    setKeeping('idle');
    if (confirmed.current) setPick(confirmed.current);
    else if (deliverTo ?? deliverGuess) {
      const ticket = ++placeTicket.current;
      // A confirmed location, or else the area guessed from the connection: the buyer confirms it.
      void lookup.locate((deliverTo ?? deliverGuess)!).then((place) => {
        if (!place || ticket !== placeTicket.current) return;
        const next: Pick = { point: place.point, origin: 'place', place };
        guessPick.current = deliverTo ? null : next;
        setPick(next);
      });
    }
    const narrow = typeof window.matchMedia === 'function' && window.matchMedia(NARROW).matches;
    dialog.current
      ?.querySelector<HTMLElement>(narrow ? '.lmx' : 'input')
      ?.focus({ preventScroll: true });
    return () => {
      if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true });
    };
    // Only opening resets the modal; the stored location is read at that moment.
  }, [open]);

  const postcode = pick.place?.postcode;
  useEffect(() => {
    if (!source.live || !open || postcode === undefined) return;
    let current = true;
    void lookup.delivers(postcode).then((delivers) => {
      if (current) setAreaAnswer({ postcode, delivers });
    });
    return () => {
      current = false;
    };
  }, [source.live, open, postcode, lookup]);
  const answered = areaAnswer?.postcode === postcode ? areaAnswer?.delivers : undefined;
  // The API's yes or no wins; with no answer the area's boundary is the preview.
  const inside =
    typeof answered === 'boolean' ? answered : insideArea(pick.point, source.area.boundary);
  const checking = source.live === true && postcode !== undefined && answered === undefined;
  /** The API did not answer for this postcode: the boundary preview stands, unconfirmed. */
  const unconfirmed = source.live === true && answered === null;
  const ready = inside && pick.place !== null && !pick.pending && !checking;
  const area = source.area.name;

  const close = () => setDeliverOpen(false);
  const choose = (place: Place, savedId?: string) => {
    placeTicket.current++;
    setPick({ point: place.point, origin: 'place', place, ...(savedId ? { savedId } : {}) });
    setResults(null);
    setActive(-1);
  };
  const pinAt = (point: GeoPoint, origin: Origin) => {
    const ticket = ++placeTicket.current;
    // The place found before stays until the lookup answers, so the summary does not flicker.
    setPick((before) => ({ point, origin, place: before.place, pending: true }));
    void lookup.suburbAt(point).then((place) => {
      if (ticket === placeTicket.current) setPick({ point, origin, place });
    });
  };
  const search = (value: string) => {
    setQuery(value);
    setActive(-1);
    const ticket = ++searchTicket.current;
    setSearchNote(null);
    setSearching(false);
    if (!value.trim()) {
      setResults(null);
      return;
    }
    if (source.live && value.trim().length < MIN_QUERY) {
      setResults(null);
      setSearchNote('short');
      return;
    }
    // Rank towards the pin only once the buyer set it: the start point is the sample area's.
    const near = pick.point === source.start.point ? undefined : pick.point;
    if (source.live) setSearching(true);
    lookup.search(value, near).then(
      (found) => {
        if (ticket !== searchTicket.current) return;
        setSearching(false);
        setResults(found);
      },
      (error: unknown) => {
        if (ticket !== searchTicket.current) return;
        setSearching(false);
        setResults(null);
        setSearchNote(error instanceof SearchProblem ? error.kind : 'failed');
      },
    );
  };
  const pickResult = (place: Place) => {
    choose(place);
    setQuery(addressLine(place));
    input.current?.focus();
  };
  const clear = () => {
    searchTicket.current++;
    setSearchNote(null);
    setSearching(false);
    setQuery('');
    setResults(null);
    setActive(-1);
    input.current?.focus();
  };
  const locateDevice = () => {
    if (locating === 'busy') return;
    setResults(null);
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setLocating('failed');
      return;
    }
    setLocating('busy');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        if (!openNow.current) return;
        setLocating('idle');
        setQuery('');
        pinAt({ lat: position.coords.latitude, lng: position.coords.longitude }, 'device');
      },
      (error) => {
        if (!openNow.current) return;
        setLocating(error.code === error.PERMISSION_DENIED ? 'blocked' : 'failed');
      },
      { timeout: 15000, maximumAge: 60000 },
    );
  };
  const chooseSaved = (id: string, line: string) => {
    setSavedFailed(false);
    lookup.search(line).then(
      (found) => {
        const place = found.find((p) => addressLine(p) === line) ?? found[0];
        if (place) {
          setQuery('');
          choose(place, id);
        } else setSavedFailed(true);
      },
      () => setSavedFailed(true),
    );
  };
  /** A street address picked from the search, not yet in the signed-in buyer's address book. */
  const keepable =
    customer !== null && pick.origin === 'place' && !pick.savedId && !!pick.place?.street;
  const keep = () => {
    if (!pick.place || keeping === 'busy') return;
    const ticket = placeTicket.current;
    setKeeping('busy');
    void lookup.keep(pick.place).then((place) => {
      if (!openNow.current || ticket !== placeTicket.current) return;
      if (
        !place ||
        !writeAddressPrefill({
          street: place.street,
          suburb: place.suburb,
          postcode: place.postcode,
        })
      ) {
        setKeeping('failed');
        return;
      }
      setKeeping('idle');
      close();
      router.push('/account/addresses');
    });
  };
  const confirm = () => {
    if (!ready || !pick.place) return;
    const to = { suburb: pick.place.suburb, postcode: pick.place.postcode };
    saveDeliverTo(to);
    setDeliverTo(to);
    confirmed.current = pick;
    guessPick.current = null;
    close();
    router.refresh();
  };

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!results) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (results.length === 0) return;
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => Math.min(results.length - 1, Math.max(0, i + step)));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const place = results[active >= 0 ? active : 0];
      if (place) pickResult(place);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setResults(null);
      setActive(-1);
    }
  };
  // Esc closes; Tab stays inside the dialog.
  const onDialogKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== 'Tab' || !dialog.current) return;
    const focusable = [
      ...dialog.current.querySelectorAll<HTMLElement>('button, input, a[href]'),
    ].filter((el) => !el.hasAttribute('disabled') && el.getClientRects().length > 0);
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  if (!mounted || !open) return null;

  let summary: string;
  if (pick.origin === 'place') summary = pick.place ? addressLine(pick.place) : area;
  else if (!inside)
    summary = t(pick.origin === 'device' ? 'device-outside' : 'dropped-outside', { area });
  else
    summary = t(pick.origin === 'device' ? 'device-near' : 'dropped-near', {
      place: pick.place ? locality(pick.place) : area,
    });
  const listOpen = results !== null && results.length > 0;
  let status: string;
  if (checking) status = t('checking');
  else if (inside) status = t('in-area');
  else status = t('out-of-area', { area });
  // One short announcement per settled pick, not the whole summary box on every change.
  const announced = pick.pending ? '' : `${summary}. ${status}`;

  return createPortal(
    <div className="lmw">
      <div className="lmscrim" onClick={close} />
      <div className="lmbox">
        <div
          className="lmdlg"
          ref={dialog}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          onKeyDown={onDialogKey}
        >
          <div className="lmside">
            <div className="lmh">
              <h2 id={titleId}>{t('title')}</h2>
              <button className="iconbtn" type="button" aria-label={t('close')} onClick={close}>
                <Icon name="close" />
              </button>
            </div>
            <div className="lmb">
              <div className="lmsr">
                <label htmlFor={`${ids}-q`}>{t('search-label')}</label>
                <div className="lmin">
                  <Icon name="search" />
                  <input
                    id={`${ids}-q`}
                    ref={input}
                    role="combobox"
                    aria-expanded={listOpen}
                    aria-controls={listId}
                    aria-autocomplete="list"
                    aria-busy={searching || undefined}
                    aria-activedescendant={listOpen && active >= 0 ? optionId(active) : undefined}
                    autoComplete="off"
                    placeholder={t('search-placeholder')}
                    value={query}
                    onChange={(event) => search(event.target.value)}
                    onKeyDown={onSearchKey}
                  />
                  {query ? (
                    <button type="button" aria-label={t('clear')} onClick={clear}>
                      <Icon name="close" />
                    </button>
                  ) : null}
                </div>
                {listOpen ? (
                  <ul
                    className="lmlist"
                    id={listId}
                    role="listbox"
                    aria-label={t('suggestions')}
                    aria-busy={searching || undefined}
                  >
                    {results.map((place, i) => (
                      <li
                        key={place.id}
                        id={optionId(i)}
                        role="option"
                        aria-selected={i === active}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => pickResult(place)}
                      >
                        <Icon name="pin" />
                        <span>
                          <b>{place.street || place.suburb}</b>
                          <small>
                            {place.street
                              ? locality(place)
                              : t('suburb-line', {
                                  region: place.region,
                                  postcode: place.postcode,
                                })}
                          </small>
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                <p className="lmnone" role="status">
                  {searchNote
                    ? t(`search-${searchNote}`)
                    : searching && !listOpen
                      ? t('searching')
                      : results?.length === 0
                        ? t('no-match')
                        : null}
                </p>
              </div>
              <button
                className="lmgps"
                type="button"
                aria-busy={locating === 'busy' || undefined}
                onClick={locateDevice}
              >
                {locating === 'busy' ? (
                  <>
                    <span className="spin" aria-hidden="true" />
                    {t('finding')}
                  </>
                ) : (
                  <>
                    <Icon name="gps" />
                    {t('use-location')}
                  </>
                )}
              </button>
              {locating === 'blocked' || locating === 'failed' ? (
                <Problem>{t(locating)}</Problem>
              ) : null}
              <p className="sr-only" role="status">
                {announced}
              </p>
              <div className="lmsel">
                <small>{t('delivering-to')}</small>
                <b>{summary}</b>
                {checking ? (
                  <span className="lmst" id={`${ids}-checking`}>
                    <span className="spin" aria-hidden="true" />
                    {t('checking')}
                  </span>
                ) : inside ? (
                  <span className="lmst ok">
                    <Icon name="check" />
                    {t('in-area')}
                  </span>
                ) : (
                  <span className="lmst no">
                    <Icon name="info" />
                    <span>{t('out-of-area', { area })}</span>
                  </span>
                )}
                {unconfirmed && inside ? <small>{t('area-unconfirmed')}</small> : null}
                {pick.origin === 'device' && inside ? <small>{t('device-note')}</small> : null}
                {pick === guessPick.current ? (
                  <small>{t('guess-note')}</small>
                ) : source.live && pick.origin === 'place' && pick.place?.street === '' ? (
                  <small>{t('suburb-hint')}</small>
                ) : null}
                {keepable ? (
                  <button
                    className="lnk lmkeep"
                    type="button"
                    aria-busy={keeping === 'busy' || undefined}
                    onClick={keep}
                  >
                    {keeping === 'busy' ? t('keeping') : t('keep')}
                  </button>
                ) : null}
              </div>
              {keepable && keeping === 'failed' ? <Problem>{t('keep-failed')}</Problem> : null}
              {customer ? (
                <fieldset className="lmsv">
                  <legend>{t('saved')}</legend>
                  <div className="aopts">
                    {customer.addresses.map((address) => {
                      const line = savedLine(address, source.area.regionCode);
                      return (
                        <label className="aopt" key={address.id}>
                          <input
                            type="radio"
                            name={`${ids}-saved`}
                            value={address.id}
                            checked={pick.savedId === address.id}
                            onChange={() => chooseSaved(address.id, line)}
                          />
                          <b>{recipientName(address)}</b>
                          <span>{line}</span>
                        </label>
                      );
                    })}
                  </div>
                  {savedFailed ? <Problem>{t('saved-failed')}</Problem> : null}
                </fieldset>
              ) : (
                <p className="lmpriv">
                  {t.rich('log-in', {
                    login: (chunks) => (
                      <button
                        className="lnk"
                        type="button"
                        aria-haspopup="dialog"
                        onClick={() => {
                          close();
                          setLoginOpen(true);
                        }}
                      >
                        {chunks}
                      </button>
                    ),
                  })}
                </p>
              )}
              <p className="lmpriv">{t(customer ? 'privacy-account' : 'privacy-guest')}</p>
              {source.live ? <p className="lmpriv">{t('privacy-provider')}</p> : null}
              {!deliverTo && deliverGuess ? (
                <p className="lmpriv">{t('privacy-estimate')}</p>
              ) : null}
            </div>
            <div className="lmf">
              <button className="btn ghost" type="button" onClick={close}>
                {t('cancel')}
              </button>
              <button
                className="btn"
                type="button"
                aria-disabled={!ready}
                aria-describedby={checking ? `${ids}-checking` : undefined}
                onClick={confirm}
              >
                {t('confirm')}
              </button>
            </div>
          </div>
          <DeliveryMap
            map={source.map}
            areaName={area}
            boundary={source.area.boundary}
            bounds={source.bounds}
            labels={source.suburbs}
            point={pick.point}
            outside={!inside}
            accuracy={pick.origin === 'device' && inside}
            onMove={(point) => {
              setQuery('');
              setResults(null);
              pinAt(point, 'pin');
            }}
          >
            <button className="iconbtn lmx" type="button" aria-label={t('close')} onClick={close}>
              <Icon name="close" />
            </button>
          </DeliveryMap>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Problem({ children }: { readonly children: ReactNode }) {
  return (
    <div className="lmerr" role="alert">
      <Icon name="info" />
      <span>{children}</span>
    </div>
  );
}
