import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { ProductCard } from '../home/product-card.tsx';
import { Icon, categoryIcon } from '../icons/icon.tsx';
import type { UnavailableProduct } from '../storefront/types.ts';
import { FocusTitle } from './focus-title.tsx';

/**
 * A removed product (approved design errors-a-teal v1): the greyed product, a way to similar
 * products and to its seller, and the similar products. No reason and no "notify me".
 */
export function UnavailableProductView({ product }: { readonly product: UnavailableProduct }) {
  const t = useTranslations('errors');
  return (
    <div className="er">
      <div className="er-box">
        <div className="er-ic" aria-hidden="true">
          <Icon name="box" />
        </div>
        <FocusTitle>{t('product-title')}</FocusTitle>
        <p>{t('product-message')}</p>
        <div className="er-pr">
          <span className="t" aria-hidden="true">
            <Icon name={categoryIcon(product.category)} />
            {product.imageUrl ? (
              <img src={product.imageUrl} alt="" decoding="async" />
            ) : null}
          </span>
          <div>
            <b>{product.name}</b>
            <span>{product.seller.name}</span>
            <span className="tag">{t('not-available')}</span>
          </div>
        </div>
        <div className="er-act">
          {product.similar.length > 0 ? (
            <a className="btn" href="#similar">
              {t('see-similar')}
            </a>
          ) : null}
          <Link
            className={product.similar.length > 0 ? 'btn ghost' : 'btn'}
            href={`/s/${product.seller.id}`}
          >
            {t('visit-seller', { seller: product.seller.name })}
          </Link>
        </div>
      </div>
      {product.similar.length > 0 ? (
        <section className="er-sec" id="similar" aria-labelledby="er-similar" tabIndex={-1}>
          <h2 id="er-similar">{t('similar')}</h2>
          <div className="grid">
            {product.similar.map((p) => (
              <ProductCard key={p.id} product={p} />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
