import { useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { SellerLogo } from '../product/seller-logo.tsx';
import type { SellerShop } from '../storefront/types.ts';
import { Ring } from './rings.tsx';
import './store-images.css';
import { ShareMenu } from './share-menu.tsx';

// The seller page's header card (approved design v9): the neutral banner with the Share pill, the
// logo, the name and its line, the performance rings and the facts as chips. The logo overlaps
// the banner from the tablet layout up and sits below it on a phone.

export function SellerHead({
  shop,
  ratingsShown,
}: {
  readonly shop: SellerShop;
  readonly ratingsShown: boolean;
}) {
  const t = useTranslations('seller');
  const tp = useTranslations('product');
  const locale = useLocale();
  const rated = shop.ratings !== undefined && shop.ratings.count > 0;
  return (
    <header className="shop-head">
      <div className={shop.banner === undefined ? 'shop-banner' : 'shop-banner has-image'}>
        {shop.banner === undefined ? null : (
          <img
            src={shop.banner.src}
            width={shop.banner.width}
            height={shop.banner.height}
            alt={t('banner-alt', { name: shop.name })}
            decoding="async"
          />
        )}
      </div>
      <ShareMenu name={shop.name} path={`/s/${shop.id}`} />
      <div className="shop-body">
        <div className="shop-id">
          <SellerLogo logo={shop.logo} image={shop.logoImage} alt={shop.name} />
          <div className="shop-title">
            <h1>{shop.name}</h1>
            <p className="shop-meta">
              <span>
                <Icon name="pin" />
                {shop.location}
              </span>
              <span>
                <Icon name="clock" />
                {t('selling-since', { year: String(shop.sellingSince) })}
              </span>
            </p>
          </div>
          {ratingsShown && rated ? (
            <div className="shop-rings" role="group" aria-label={t('performance')}>
              <Ring label={t('satisfaction')} value={shop.ratings.satisfaction} />
              <Ring label={t('on-time')} value={shop.ratings.onTime} />
              <Ring label={t('as-described')} value={shop.ratings.asDescribed} />
            </div>
          ) : null}
        </div>
        <ul className="shop-chips">
          {(shop.certificates ?? []).map((c) => (
            <li key={c.type}>
              <Icon name="check" />
              {tp('certificate-checked', { name: c.name })}
            </li>
          ))}
          {rated ? null : (
            <li className="new">
              <Icon name="info" />
              {t('new-seller')}
            </li>
          )}
          {shop.deliveryWindow === undefined ? null : (
            <li>
              <Icon name="truck" />
              {shop.deliveryWindow}
            </li>
          )}
          {shop.minimumUnknown ? null : (
            <li>
              <Icon name="receipt" />
              {shop.minimumOrder
                ? t('minimum', { amount: formatMoney(shop.minimumOrder, locale) })
                : t('no-minimum')}
            </li>
          )}
          {shop.deliveryFee === undefined ? null : (
            <li>
              <Icon name="truck" />
              <span className="num">
                {t('delivery-fee', { fee: formatMoney(shop.deliveryFee, locale) })}
              </span>
            </li>
          )}
        </ul>
      </div>
    </header>
  );
}
