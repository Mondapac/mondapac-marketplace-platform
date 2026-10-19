import { useLocale, useTranslations } from 'next-intl';
import { CertificationSeal } from '../certification/certification-seal.tsx';
import { formatMoney } from '../format/money.ts';
import { CategoryArt } from '../icons/category-icon.tsx';
import type { ProductCard as Product } from '../storefront/types.ts';
import { AddControl } from './add-control.tsx';

export function ProductCard({ product }: { readonly product: Product }) {
  const t = useTranslations('home');
  const locale = useLocale();
  const special = product.wasPrice !== undefined;
  const price = formatMoney(product.price, locale);
  return (
    <article className="pc">
      <div className="tile">
        {product.imageUrl ? (
          // Placeholder photos are local files; seller media moves to next/image with the media API.
          <img className="photo" src={product.imageUrl} alt="" loading="lazy" decoding="async" />
        ) : (
          <CategoryArt code={product.category} />
        )}
        {special ? <span className="badge">{t('special-price')}</span> : null}
        {product.certifications.map((badge) => (
          <CertificationSeal key={badge.type} badge={badge} />
        ))}
        <AddControl product={product} />
      </div>
      <div className="pr num">
        <b className={special ? 'sp' : undefined}>{price}</b>
        {product.wasPrice ? (
          <s>
            <span className="sr-only">{t('regular-price')}</span>
            {formatMoney(product.wasPrice, locale)}
          </s>
        ) : null}
      </div>
      <div className="gst">{t('including-gst')}</div>
      <h3 className="nm">{product.name}</h3>
      <div className="by">{product.sellerName}</div>
      {product.lowStock !== undefined ? (
        <div className="low">{t('only-left', { count: product.lowStock })}</div>
      ) : null}
    </article>
  );
}
