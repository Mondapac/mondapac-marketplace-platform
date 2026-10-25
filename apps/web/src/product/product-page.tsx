import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { sealArt } from '../certification/certification-seal.tsx';
import { Crumbs } from '../catalog/results.tsx';
import { formatDate } from '../format/date.ts';
import { formatMoney } from '../format/money.ts';
import { ProductCard } from '../home/product-card.tsx';
import { Icon } from '../icons/icon.tsx';
import type {
  Category,
  CertificationBadge,
  ProductDetail,
  ProductOffer,
} from '../storefront/types.ts';
import { BuyControl } from './buy-control.tsx';
import { Description } from './description.tsx';
import { Gallery } from './gallery.tsx';
import { SellerBlock, SellerCards } from './seller-card.tsx';

// The product page of the approved design (v8): breadcrumb, title, gallery and the buy box (a
// sticky right column from 1000px), then certificates, details, specifications, other sellers and
// similar products. Under 1000px the buy box is in the flow and a sticky buy bar sits above the
// bottom tab bar until the end of the product section.

export function ProductPage({
  product,
  category,
}: {
  readonly product: ProductDetail;
  readonly category: Category | undefined;
}) {
  const t = useTranslations('product');
  const tc = useTranslations('catalog');
  const locale = useLocale();
  const [offer, ...others] = product.offers;
  return (
    <SellerCards>
      <Crumbs
        trail={[
          { label: tc('home'), href: '/' },
          { label: tc('browse-products'), browse: true },
          ...(category ? [{ label: category.name, href: `/c/${category.code}` }] : []),
        ]}
        current={product.name}
      />
      <div className="pdp">
        <div className="pl1">
          <div className="ptit">
            <h1>{product.name}</h1>
            <p className="pby">
              {t.rich('by', {
                name: offer.seller.name,
                seller: (chunks) => <Link href={`/s/${offer.seller.id}`}>{chunks}</Link>,
              })}
            </p>
          </div>
          <Gallery
            name={product.name}
            category={product.category}
            photos={product.photos}
            thumbs={product.photoThumbs}
            certifications={offer.certifications.filter((badge) => badge.sellerClaim !== true)}
            special={offer.wasPrice !== undefined}
          />
        </div>
        <aside className="pr1" aria-label={t('buy-options')}>
          <BuyBox offer={offer} others={others} />
        </aside>
        <div className="pl2">
          <Certificates offer={offer} />
          {product.description || product.specifications.length > 0 ? (
            <section className="sec">
              <h2>{t('details')}</h2>
              {product.description ? <Description text={product.description} /> : null}
              {product.specifications.length > 0 ? (
                <>
                  <h3>{t('specifications')}</h3>
                  <dl className="spec">
                    {product.specifications.map((s) => (
                      <div key={s.label}>
                        <dt>{s.label}</dt>
                        <dd>{s.value}</dd>
                      </div>
                    ))}
                  </dl>
                </>
              ) : null}
            </section>
          ) : null}
          {others.length > 0 ? (
            <section className="sec" id="others" aria-labelledby="others-title">
              <h2 id="others-title">{t('other-sellers')}</h2>
              <div className="offs">
                {others.map((o) => (
                  <div key={o.id} className="off">
                    <div className="osl">
                      <SellerBlock offer={o} placement="row" />
                      {o.certifications.map((c) => (
                        <span
                          key={c.type}
                          className={c.sellerClaim === true ? 'badge decl' : 'badge hl'}
                        >
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
          ) : null}
        </div>
      </div>
      {product.similar.length > 0 ? (
        <section className="sec">
          <div className="sech">
            <h2>{t('similar')}</h2>
            {category ? (
              <Link
                href={`/c/${category.code}`}
                aria-label={t('show-all-similar', { category: category.name })}
              >
                {t('show-all')}
                <Icon name="chevr" />
              </Link>
            ) : null}
          </div>
          <div className="srow2">
            {product.similar.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      ) : null}
      <div className="buybar">
        <div className="num">
          <b>{formatMoney(offer.price, locale)}</b>
          <small>{t('including-gst')}</small>
        </div>
        <BuyControl offer={offer} variant="bar" />
      </div>
    </SellerCards>
  );
}

function BuyBox({
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

function Certificates({ offer }: { readonly offer: ProductOffer }) {
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

/** The loading state, shaped like the page so nothing jumps when it lands. */
export function ProductLoading({ label }: { readonly label: string }) {
  return (
    <div role="status" aria-label={label} className="loading">
      <div className="skel line" />
      <div className="pdp" aria-hidden="true">
        <div className="pl1">
          <div className="skel title" />
          <div className="skel gphoto" />
        </div>
        <div className="pr1">
          <div className="skel bbox" />
        </div>
      </div>
    </div>
  );
}
