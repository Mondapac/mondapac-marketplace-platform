import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { Crumbs } from '../catalog/results.tsx';
import { ProductCard } from '../home/product-card.tsx';
import { Icon } from '../icons/icon.tsx';
import type { Category, ProductDetail, ProductSpecification } from '../storefront/types.ts';
import { ProductReviews } from '../reviews/product-reviews.tsx';
import type { ProductReviews as ProductReviewsData } from '../reviews/reviews-source.ts';
import { TabBarAutoHide } from '../shell/tabbar-autohide.tsx';
import { Collapsible } from './collapsible.tsx';
import { Description } from './description.tsx';
import { SellerCards } from './seller-card.tsx';
import {
  SelectedBuyBar,
  SelectedBuyBox,
  SelectedByline,
  SelectedCertificates,
  SelectedGallery,
  SelectedOffer,
  SelectedOtherSellers,
} from './selected-offer.tsx';

// The product page of the approved design (v8): breadcrumb, title, gallery and the buy box (a
// sticky right column from 1000px), then certificates, details, specifications, other sellers and
// similar products. Under 1000px the buy box is in the flow and a sticky buy bar sits above the
// bottom tab bar until the end of the product section.

interface SpecGroup {
  readonly code: string | undefined;
  readonly label: string | undefined;
  readonly rows: ProductSpecification[];
}

/**
 * The specification rows in runs of one group. A heading shows only when there are several
 * groups and the group has a word; one group is one plain table, as before.
 */
function specGroups(rows: readonly ProductSpecification[]): SpecGroup[] {
  const groups: SpecGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last !== undefined && last.code === row.group) last.rows.push(row);
    else groups.push({ code: row.group, label: row.groupLabel, rows: [row] });
  }
  return groups.length > 1 ? groups : groups.map((group) => ({ ...group, label: undefined }));
}

export function ProductPage({
  product,
  category,
  reviews = null,
  initialVariantId,
}: {
  readonly product: ProductDetail;
  readonly category: Category | undefined;
  /** The product's reviews while the Market's reviews switch is on and there is one; else null. */
  readonly reviews?: ProductReviewsData | null;
  /** The Variant the link names (`?v=`), already checked; absent opens the default Variant. */
  readonly initialVariantId?: string | undefined;
}) {
  const t = useTranslations('product');
  const tc = useTranslations('catalog');
  return (
    <SellerCards>
      <SelectedOffer
        key={`${product.id}:${initialVariantId ?? ''}`}
        product={product}
        initialVariantId={initialVariantId}
      >
        <TabBarAutoHide />
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
              <SelectedByline />
            </div>
            <SelectedGallery />
          </div>
          <aside className="pr1" aria-label={t('buy-options')}>
            <SelectedBuyBox />
          </aside>
          <div className="pl2">
            <SelectedCertificates />
            {product.description || product.specifications.length > 0 ? (
              <section className="sec">
                {product.description ? (
                  <Collapsible title={t('details')} level="h2">
                    <Description text={product.description} />
                  </Collapsible>
                ) : null}
                {product.specifications.length > 0 ? (
                  <Collapsible
                    title={t('specifications')}
                    level={product.description ? 'h3' : 'h2'}
                  >
                    {specGroups(product.specifications).map((group, index) => (
                      <div key={group.code ?? index} className="spec-group">
                        {group.label === undefined ? null : (
                          <h4 className="spec-title">{group.label}</h4>
                        )}
                        <dl className="spec">
                          {group.rows.map((s) => (
                            <div key={s.label}>
                              <dt>{s.label}</dt>
                              <dd>{s.value}</dd>
                            </div>
                          ))}
                        </dl>
                      </div>
                    ))}
                  </Collapsible>
                ) : null}
              </section>
            ) : null}
            <SelectedOtherSellers />
          </div>
        </div>
        {reviews === null ? null : (
          <ProductReviews
            productId={product.id}
            summary={reviews.summary}
            initial={reviews.page}
            sellers={Object.fromEntries(
              (product.variants?.flatMap((v) => v.offers) ?? product.offers).map((o) => [
                o.seller.id.toLowerCase(),
                o.seller.name,
              ]),
            )}
          />
        )}
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
        <SelectedBuyBar />
      </SelectedOffer>
    </SellerCards>
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
