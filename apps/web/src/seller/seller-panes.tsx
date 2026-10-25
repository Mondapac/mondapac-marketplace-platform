import { useFormatter, useLocale, useTranslations } from 'next-intl';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { useDeliveryLine } from './delivery-line.ts';
import type { SellerCertificate, SellerShop } from '../storefront/types.ts';

// The About and Certificates tabs of the seller page. No seller contact details: orders, delivery
// problems and refunds go through Mondapac. A certificate shows only as the platform approved it.

function Note({ children }: { readonly children: string }) {
  return (
    <p className="shop-note">
      <Icon name="info" />
      <span>{children}</span>
    </p>
  );
}

function Facts({
  rows,
}: {
  readonly rows: readonly (readonly [string, string | undefined, boolean?])[];
}) {
  return (
    <dl className="shop-facts">
      {rows
        .flatMap(([term, value, numeric]) =>
          // A fact the seller read does not know yet is left out.
          value === undefined ? [] : [[term, value, numeric] as const],
        )
        .map(([term, value, numeric]) => (
          <div key={term}>
            <dt>{term}</dt>
            <dd className={numeric ? 'num' : undefined}>{value}</dd>
          </div>
        ))}
    </dl>
  );
}

export function AboutPane({ shop }: { readonly shop: SellerShop }) {
  const t = useTranslations('seller');
  const locale = useLocale();
  const deliveryLine = useDeliveryLine(shop);
  return (
    <div className="shop-boxes">
      {shop.about === undefined ? null : (
        <section className="shop-box">
          <h2>{t('about', { name: shop.name })}</h2>
          <p className="shop-text shop-about">{shop.about}</p>
        </section>
      )}
      <section className="shop-box">
        <h2>{t('details')}</h2>
        <Facts
          rows={[
            [t('business'), shop.businessCheck],
            [t('location-label'), shop.location],
            [t('since-label'), String(shop.sellingSince)],
            [t('delivery'), deliveryLine],
            [
              t('fee-label'),
              shop.deliveryFee ? formatMoney(shop.deliveryFee, locale) : undefined,
              true,
            ],
            [
              t('minimum-label'),
              shop.minimumUnknown
                ? undefined
                : shop.minimumOrder
                  ? formatMoney(shop.minimumOrder, locale)
                  : t('no-minimum'),
              shop.minimumOrder !== undefined,
            ],
            [t('delivers-to'), shop.deliversTo],
          ]}
        />
        <Note>{t('through-mondapac')}</Note>
      </section>
    </div>
  );
}

export function CertificatesPane({
  shop,
  certificates,
}: {
  readonly shop: SellerShop;
  readonly certificates: readonly SellerCertificate[];
}) {
  const t = useTranslations('seller');
  const format = useFormatter();
  if (certificates.length === 0)
    return (
      <section className="shop-box">
        <h2>{t('certificates')}</h2>
        <p className="shop-text">{t('no-certificates', { name: shop.name })}</p>
        <Note>{t('no-certificates-note')}</Note>
      </section>
    );
  const date = (iso: string) =>
    format.dateTime(new Date(`${iso}T00:00:00Z`), {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
  return (
    <div className="shop-boxes">
      <div className="shop-certs">
        {certificates.map((c) => (
          <section key={c.type} className="shop-box">
            <h2>{t('certificate', { name: c.name })}</h2>
            <span className="shop-ok">
              <Icon name="check" />
              {t('in-date')}
            </span>
            <Facts
              rows={[
                [t('certifier'), c.certifier],
                [t('number'), c.number],
                [t('valid-until'), date(c.validUntil)],
                [t('checked-on'), date(c.checkedOn)],
              ]}
            />
          </section>
        ))}
      </div>
      <section className="shop-box">
        <h2>{t('how-we-check')}</h2>
        <p className="shop-text">{t('how-we-check-body')}</p>
        <Note>{t('no-rulings')}</Note>
      </section>
    </div>
  );
}
