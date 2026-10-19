'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { ProductOffer } from '../storefront/types.ts';
import { SellerLogo } from './seller-logo.tsx';

// The seller card of the product page (john's decisions, approved design v8). On the desktop
// layout (1000px and wider) hover, focus or a click on the seller block opens the card beside it;
// it closes when the pointer leaves, on Esc and on an outside click. Phone and tablet have no
// hover: "Seller info" under the seller name opens the card as a centred modal with the logo.

const WIDE = '(min-width: 1000px)';
const CLOSE_DELAY = 140;

const wide = () => typeof window.matchMedia === 'function' && window.matchMedia(WIDE).matches;

interface OpenCard {
  readonly id: string;
  readonly modal: boolean;
}

interface Cards {
  readonly open: OpenCard | null;
  readonly setOpen: Dispatch<SetStateAction<OpenCard | null>>;
}

const CardsContext = createContext<Cards | null>(null);

/** One seller card open at a time on the page; a change of layout closes it. */
export function SellerCards({ children }: { readonly children: ReactNode }) {
  const [open, setOpen] = useState<OpenCard | null>(null);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(WIDE);
    const close = () => setOpen(null);
    media.addEventListener('change', close);
    return () => media.removeEventListener('change', close);
  }, []);
  const value = useMemo(() => ({ open, setOpen }), [open]);
  return <CardsContext.Provider value={value}>{children}</CardsContext.Provider>;
}

function useCards(): Cards {
  const cards = useContext(CardsContext);
  if (!cards) throw new Error('SellerBlock outside SellerCards');
  return cards;
}

/** The seller line (logo, optional label, name, "Seller info") with its card. */
export function SellerBlock({
  offer,
  label,
  placement,
}: {
  readonly offer: ProductOffer;
  readonly label?: string;
  /** `box`: the card opens left of the buy box; `row`: right of the logo of an offer row. */
  readonly placement: 'box' | 'row';
}) {
  const t = useTranslations('product');
  const { open, setOpen } = useCards();
  const { setDialogOpen } = useStore();
  const id = useId();
  const cardId = `seller-card${id}`;
  const wrap = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const isOpen = open?.id === id;
  const modal = isOpen && open.modal;

  const show = useCallback(() => {
    if (!wide()) return;
    clearTimeout(timer.current);
    setOpen({ id, modal: false });
  }, [id, setOpen]);
  // Closes this block's card only: another block may have opened its own meanwhile.
  const close = useCallback(() => {
    clearTimeout(timer.current);
    setOpen((current) => (current?.id === id ? null : current));
  }, [id, setOpen]);
  const hide = () => {
    if (!wide()) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(close, CLOSE_DELAY);
  };
  const showModal = () => {
    clearTimeout(timer.current);
    setOpen({ id, modal: true });
  };

  useEffect(() => () => clearTimeout(timer.current), []);

  // Esc closes the card; a click outside closes the desktop card.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };
    const onClick = (event: MouseEvent) => {
      if (!modal && !wrap.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('click', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('click', onClick);
    };
  }, [isOpen, modal, close]);

  // The modal makes the page inert; closing it returns focus to "Seller info".
  useEffect(() => {
    if (!modal) return;
    setDialogOpen(true);
    const button = opener.current;
    return () => {
      setDialogOpen(false);
      button?.focus({ preventScroll: true });
    };
  }, [modal, setDialogOpen]);

  const name = offer.seller.name;
  return (
    <div
      className={`sw ${placement}`}
      ref={wrap}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={(event) => {
        if (!wrap.current?.contains(event.relatedTarget)) hide();
      }}
    >
      <div className="sline" onClick={show}>
        <SellerLogo logo={offer.seller.logo} />
        <div className="sname">
          {label ? <small>{label}</small> : null}
          <button
            className="strig"
            type="button"
            aria-expanded={isOpen && !modal}
            aria-controls={cardId}
            onClick={() => (wide() ? show() : showModal())}
          >
            {name}
          </button>
          <button
            className="sinfo"
            type="button"
            ref={opener}
            aria-haspopup="dialog"
            aria-label={t('seller-details', { seller: name })}
            onClick={showModal}
          >
            {t('seller-info')}
            <Icon name="chevr" />
          </button>
        </div>
      </div>
      <div
        className="spop"
        id={cardId}
        role="group"
        aria-label={t('seller-details', { seller: name })}
        hidden={!isOpen || modal}
      >
        <CardBody offer={offer} />
      </div>
      {modal ? <SellerModal offer={offer} onClose={close} /> : null}
    </div>
  );
}

function SellerModal({
  offer,
  onClose,
}: {
  readonly offer: ProductOffer;
  readonly onClose: () => void;
}) {
  const t = useTranslations('product');
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  useEffect(() => closeButton.current?.focus({ preventScroll: true }), []);
  return createPortal(
    <div className="smodal">
      <div className="sscrim" onClick={onClose} />
      <div className="spop asmodal" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <button
          className="smx"
          type="button"
          ref={closeButton}
          aria-label={t('close')}
          onClick={onClose}
        >
          <Icon name="close" />
        </button>
        <CardBody offer={offer} titleId={titleId} logo />
      </div>
    </div>,
    document.body,
  );
}

function Meter({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <div className="mrow">
      <span>{label}</span>
      <b className="num">{value}%</b>
      <i className="bar" aria-hidden="true">
        <u style={{ width: `${value}%` }} />
      </i>
    </div>
  );
}

function CardBody({
  offer,
  titleId,
  logo = false,
}: {
  readonly offer: ProductOffer;
  readonly titleId?: string;
  readonly logo?: boolean;
}) {
  const t = useTranslations('product');
  const { seller } = offer;
  return (
    <>
      <div className="sph">
        {logo ? <SellerLogo logo={seller.logo} /> : null}
        <div>
          <b id={titleId}>{seller.name}</b>
          <small>{t('since', { city: seller.city, year: String(seller.sellingSince) })}</small>
        </div>
      </div>
      {seller.ratings ? (
        <>
          <div className="sat">
            <b className="num">{seller.ratings.satisfaction}%</b>
            <span>{t('satisfaction')}</span>
            <small>{t('ratings', { count: seller.ratings.count })}</small>
            <i className="bar" aria-hidden="true">
              <u style={{ width: `${seller.ratings.satisfaction}%` }} />
            </i>
          </div>
          <Meter label={t('on-time')} value={seller.ratings.onTime} />
          <Meter label={t('as-described')} value={seller.ratings.asDescribed} />
        </>
      ) : null}
      <ul className="sp3">
        {seller.certificates.map((c) => (
          <li key={c.type}>
            <Icon name="store" />
            {t('certificate-checked', { name: c.name })}
          </li>
        ))}
        <li>
          <Icon name="truck" />
          {offer.deliveryWindow}
        </li>
        <li>
          <Icon name="receipt" />
          {offer.minimumOrder}
        </li>
      </ul>
      <Link className="spl" href={`/s/${seller.id}`}>
        {t('seller-page')}
        <Icon name="chevr" />
      </Link>
    </>
  );
}
