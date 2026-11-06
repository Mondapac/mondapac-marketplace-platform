'use client';

import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { sealArt } from '../certification/certification-seal.tsx';
import { formatDate } from '../format/date.ts';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { defaultVariantOf } from '../storefront/variants.ts';
import type {
  CertificationBadge,
  ProductDetail,
  ProductOffer,
  ProductVariant,
} from '../storefront/types.ts';
import { BuyControl } from './buy-control.tsx';
import { Gallery } from './gallery.tsx';
import { SellerBlock } from './seller-card.tsx';
import { VariantPicker } from './variant-picker.tsx';

// The parts of the product page that follow the buyer's Variant choice. The page opens on one
// Variant (the `?v=` of the link, else the default); picking another swaps the price, the sellers,
// the certificates and the add-to-cart without leaving the page, and writes `?v=` to the address
// (the canonical link never carries it).

interface Selected {
  readonly product: ProductDetail;
  /** The Variant on show; absent for a product with one. */
  readonly variant: ProductVariant | undefined;
  readonly offer: ProductOffer;
  readonly others: readonly ProductOffer[];
  readonly select: (id: string) => void;
}

const SelectedContext = createContext<Selected | null>(null);

export function useSelected(): Selected {
  const value = useContext(SelectedContext);
  if (value === null) throw new Error('useSelected needs a SelectedOffer');
  return value;
}

/** Keeps the chosen Variant of the page and shares it with the parts below. */
export function SelectedOffer({
  product,
  initialVariantId,
  children,
}: {
  readonly product: ProductDetail;
  /** The Variant named by `?v=`, already checked against the product's Variants. */
  readonly initialVariantId?: string | undefined;
  readonly children: ReactNode;
}) {
  const [chosen, setChosen] = useState(initialVariantId);
  const select = useCallback((id: string) => {
    setChosen(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set('v', id);
      window.history.replaceState(window.history.state, '', url);
    } catch {
      // An address that cannot be written is not worth failing the choice.
    }
  }, []);
  const value = useMemo((): Selected => {
    const variants = product.variants;
    const variant =
      variants === undefined
        ? undefined
        : (variants.find((v) => v.id === chosen) ?? defaultVariantOf(variants));
    const [offer, ...others] = variant?.offers ?? product.offers;
    return { product, variant, offer, others, select };
  }, [product, chosen, select]);
  return <SelectedContext.Provider value={value}>{children}</SelectedContext.Provider>;
}

export function SelectedByline() {
  const t = useTranslations('product');
  const { product, offer } = useSelected();
  return (
    <>
      <p className="pby">
        {t.rich('by', {
          name: offer.seller.name,
          seller: (chunks) => <Link href={`/s/${offer.seller.id}`}>{chunks}</Link>,
        })}
      </p>
      {product.brand === undefined ? null : (
        <p className="pbrand">
          {t.rich('brand', {
            name: product.brand.name,
            brand: (chunks) => (
              <Link href={`/brands/${encodeURIComponent(product.brand!.slug)}`}>{chunks}</Link>
            ),
          })}
        </p>
      )}
    </>
  );
}

export function SelectedGallery() {
  const { product, variant, offer } = useSelected();
  // A Variant that picked photos shows those, main photo first; else the product's photos.
  const picked = variant?.photoIndexes;
  const photos =
    picked === undefined ? product.photos : picked.flatMap((at) => product.photos[at] ?? []);
  const thumbs =
    picked === undefined || product.photoThumbs === undefined
      ? product.photoThumbs
      : picked.flatMap((at) => product.photoThumbs?.[at] ?? []);
  const sets =
    picked === undefined || product.photoSets === undefined
      ? product.photoSets
      : picked.flatMap((at) => product.photoSets?.[at] ?? []);
  return (
    <Gallery
      // A new Variant starts on its first photo.
      key={picked === undefined ? 'product' : (variant?.id ?? 'product')}
      name={product.name}
      category={product.category}
      photos={photos}
      thumbs={thumbs}
      sets={sets}
      certifications={offer.certifications.filter((badge) => badge.sellerClaim !== true)}
      special={offer.wasPrice !== undefined}
    />
  );
}

export function SelectedBuyBox() {
  const { offer, others } = useSelected();
  return <BuyBoxOf offer={offer} others={others} />;
}

export function SelectedCertificates() {
  const { offer } = useSelected();
  return <CertificatesOf offer={offer} />;
}

export function SelectedOtherSellers() {
  const t = useTranslations('product');
  const locale = useLocale();
  const { others } = useSelected();
  if (others.length === 0) return null;
  return (
    <section className="sec" id="others" aria-labelledby="others-title">
      <h2 id="others-title">{t('other-sellers')}</h2>
      <div className="offs">
        {others.map((o) => (
          <div key={o.id} className="off">
            <div className="osl">
              <SellerBlock offer={o} placement="row" />
              {o.certifications.map((c) => (
                <span key={c.type} className={c.sellerClaim === true ? 'badge decl' : 'badge hl'}>
                  {c.sellerClaim === true ? t('declared-chip', { name: c.label }) : c.label}
                </span>
              ))}
            </div>
            {o.minimumOrder === undefined ? null : (
              <div className="ofa">
                <span>{o.minimumOrder}</span>
              </div>
            )}
            <div className="opr num">
              <b>{formatMoney(o.price, locale)}</b>
              <small>{t('including-gst')}</small>
            </div>
            <BuyControl offer={o} variant="small" />
          </div>
        ))}
      </div>
    </section>
  );
}

/** The sticky buy bar of phone and tablet; it names the chosen Variant beside the price. */
export function SelectedBuyBar() {
  const t = useTranslations('product');
  const locale = useLocale();
  const { variant, product, offer } = useSelected();
  const index = variant === undefined ? 0 : (product.variants?.indexOf(variant) ?? 0);
  return (
    <div className="buybar">
      <div className="num">
        <b>{formatMoney(offer.price, locale)}</b>
        <small>
          {variant === undefined
            ? t('including-gst')
            : `${variant.label ?? t('variant-n', { n: index + 1 })} · ${t('including-gst')}`}
        </small>
      </div>
      <BuyControl offer={offer} variant="bar" />
    </div>
  );
}

function BuyBoxOf({
  offer,
  others,
}: {
  readonly offer: ProductOffer;
  readonly others: readonly ProductOffer[];
}) {
  const t = useTranslations('product');
  const locale = useLocale();
  const special = offer.wasPrice !== undefined;
  const lowest = others.reduce<ProductOffer | undefined>(
    (low, o) => (low === undefined || o.price.amount < low.price.amount ? o : low),
    undefined,
  );
  return (
    <div className="bb">
      <VariantPicker />
      <SellerBlock offer={offer} label={t('sold-by')} placement="box" />
      <div className="bprice num">
        {special ? <span className="badge">{t('special-price')}</span> : null}
        <b className={special ? 'sp' : undefined}>{formatMoney(offer.price, locale)}</b>
        {offer.wasPrice ? (
          <s>
            <span className="sr-only">{t('regular-price')}</span>
            {formatMoney(offer.wasPrice, locale)}
          </s>
        ) : null}
      </div>
      <div className="gst">{t('including-gst')}</div>
      {offer.lowStock !== undefined && offer.lowStock > 0 ? (
        <div className="low">{t('only-left', { count: offer.lowStock })}</div>
      ) : null}
      <div className="bctl">
        <BuyControl offer={offer} variant="wide" />
      </div>
      {offer.minimumOrder === undefined ? null : (
        <ul className="bfacts">
          {offer.minimumOrder === undefined ? null : (
            <li>
              <Icon name="receipt" />
              <span>
                <b>{offer.minimumOrder}</b>
                <small>{t('shipping-note')}</small>
              </span>
            </li>
          )}
        </ul>
      )}
      {lowest ? (
        <a className="others" href="#others">
          {t('other-sellers-link', {
            count: others.length,
            price: formatMoney(lowest.price, locale),
          })}
          <Icon name="chevr" />
        </a>
      ) : null}
    </div>
  );
}

function CertificatesOf({ offer }: { readonly offer: ProductOffer }) {
  const t = useTranslations('product');
  if (offer.certifications.length === 0) return null;
  return (
    <section className="sec">
      <h2>{t('certificates')}</h2>
      <div className="certs">
        {offer.certifications.map((badge) => (
          <div key={badge.type} className="certbox">
            {badge.sellerClaim === true ? null : (
              <span className="cl" aria-hidden="true">
                {sealArt(badge.type)}
              </span>
            )}
            <div>
              <b>
                {badge.sellerClaim === true
                  ? t('declared-badge', { name: badge.label })
                  : badge.label}
              </b>
              <CertificateNote badge={badge} seller={offer.seller.name} />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Who stands behind a badge, in words, as a short hierarchy under the type name: one sentence for
 * who issued it and to whom, then one compact line for when it ends and how it was checked. The
 * seller's own declaration is never worded as certified. Dates are calendar dates, so they are
 * formatted in UTC and never shift a day.
 */
function CertificateNote({
  badge,
  seller,
}: {
  readonly badge: CertificationBadge;
  readonly seller: string;
}) {
  const t = useTranslations('product');
  const locale = useLocale();
  if (badge.sellerClaim === true) return <p>{t('certificate-declared', { seller })}</p>;
  const issuer = badge.issuer;
  const manufacturer = badge.basis === 'MANUFACTURER';
  const who =
    issuer === undefined
      ? manufacturer
        ? t('certificate-issued-manufacturer')
        : t('certificate-issued', { seller })
      : manufacturer
        ? t('certificate-issued-manufacturer-by', { issuer })
        : t('certificate-issued-by', { issuer, seller });
  const verified = badge.verifiedWithIssuer === true;
  return (
    <>
      <p>{who}</p>
      <p className="certmeta">
        {badge.validUntil === undefined ? null : (
          <span>
            {t('certificate-valid-until', {
              date: formatDate(badge.validUntil, locale, { dateStyle: 'medium' }),
            })}
          </span>
        )}
        {verified ? (
          <span className="certok">
            <Icon name="check" />
            {t('certificate-verified')}
          </span>
        ) : (
          <span>{t('certificate-reviewed')}</span>
        )}
      </p>
    </>
  );
}
