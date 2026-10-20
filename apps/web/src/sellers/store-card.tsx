import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { formatMoney } from '../format/money.ts';
import { Icon, categoryIcon } from '../icons/icon.tsx';
import { SellerLogo } from '../product/seller-logo.tsx';
import { heat } from '../seller/rings.tsx';
import type { BuyerLocation, SellerListing } from '../storefront/types.ts';

// One store of the sellers page (approved design sellers-a-teal v4): logo, name (the whole card
// opens the seller page), city and year, the satisfaction line, the chips, the delivery terms and
// a few of its products.

export function StoreCard({
  store,
  location,
  ratingsShown,
}: {
  readonly store: SellerListing;
  readonly location: BuyerLocation;
  readonly ratingsShown: boolean;
}) {
  const t = useTranslations('sellers');
  const locale = useLocale();
  const { ratings } = store;
  const rated = ratings !== undefined && ratings.count > 0;
  return (
    <article className="slc">
      <div className="slc-h">
        <span className="slc-lg">
          <SellerLogo logo={store.logo} />
        </span>
        <div>
          <h3>
            <Link href={`/s/${store.id}`} aria-label={t('open-seller', { name: store.name })}>
              {store.name}
            </Link>
          </h3>
          <p className="slc-m">
            {t('selling-since', { city: store.city, year: String(store.sellingSince) })}
          </p>
          {ratingsShown && rated ? (
            <p
              className="slc-rt"
              role="img"
              aria-label={t('satisfaction-label', {
                value: ratings.satisfaction,
                count: ratings.count,
              })}
            >
              <i style={{ background: heat(ratings.satisfaction) }} />
              {t('satisfaction', { value: ratings.satisfaction })}
              <small className="num">({ratings.count})</small>
            </p>
          ) : null}
        </div>
      </div>
      <ul className="slc-chips">
        {store.certifications.map((c) => (
          <li key={c.type}>
            <Icon name="check" />
            {t('certificate-checked', { name: c.name })}
          </li>
        ))}
        {rated ? null : <li className="new">{t('new-seller')}</li>}
        {location === 'inside' && !store.deliversHere ? (
          <li className="off">
            <Icon name="pin" />
            {t('outside-area')}
          </li>
        ) : null}
        {store.categories.map((c) => (
          <li key={c.code}>{c.name}</li>
        ))}
      </ul>
      <ul className="slc-d">
        {store.deliveryWindow === undefined ? null : (
          <li>
            <Icon name="clock" />
            {store.deliveryWindow}
          </li>
        )}
        {store.minimumUnknown ? null : (
          <li>
            <Icon name="bag" />
            {store.minimumOrder
              ? t('minimum', { amount: formatMoney(store.minimumOrder, locale) })
              : t('no-minimum')}
          </li>
        )}
        {store.deliveryFee === undefined ? null : (
          <li className="num">
            <Icon name="truck" />
            {t('delivery-fee', { fee: formatMoney(store.deliveryFee, locale) })}
          </li>
        )}
      </ul>
      {store.thumbnails.length === 0 && store.productCount === undefined ? null : (
        <div className="slc-p">
          {store.thumbnails.map((p, i) => (
            <span key={i} className="slc-th" aria-hidden="true">
              <Icon name={categoryIcon(p.category)} />
              {p.imageUrl ? <img src={p.imageUrl} alt="" loading="lazy" decoding="async" /> : null}
            </span>
          ))}
          {store.productCount === undefined ? null : (
            <span className="n num">{t('products', { count: store.productCount })}</span>
          )}
        </div>
      )}
    </article>
  );
}

/** A grey card of the loading state. */
export function StoreCardSkeleton() {
  return (
    <div className="slc sl-sk" aria-hidden="true">
      <div className="slc-h">
        <i className="lg" />
        <div className="sl-sk-lines">
          <i className="name" />
          <i className="meta" />
        </div>
      </div>
      <i className="chips" />
      <div className="sl-sk-lines">
        <i className="row" />
        <i className="row short" />
      </div>
      <i className="foot" />
    </div>
  );
}
