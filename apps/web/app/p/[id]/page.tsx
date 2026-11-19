import { getTranslations } from 'next-intl/server';
import { Suspense } from 'react';
import { ProductLoading, ProductPage } from '../../../src/product/product-page.tsx';
import { loadProductReviews } from '../../../src/reviews/reviews-source.ts';
import { JsonLd } from '../../../src/seo/json-ld.tsx';
import {
  canonicalOf,
  pageMetadata,
  requestOrigin,
  seoDescription,
} from '../../../src/seo/metadata.ts';
import { productPageStructuredData } from '../../../src/seo/structured-data.ts';
import { variantFromParam } from '../../../src/storefront/product-detail.ts';
import { productHref } from '../../../src/storefront/links.ts';
import { productForMetadata, resolveProduct } from '../../../src/storefront/product-route.ts';
import type { ProductDetail } from '../../../src/storefront/types.ts';
import { loadStorefrontContent } from '../../../src/storefront/source.ts';

interface Props {
  /** `[id]` holds `<name>-<id>`: the page is found by the id at its end. */
  readonly params: Promise<{ id: string }>;
  /** `?v=` names a Variant to open on; the canonical link never carries it. */
  readonly searchParams?: Promise<{ v?: string | string[] }>;
}

/** `?v=` and the rest of the query, for the redirect that keeps them. */
const queryOf = async (searchParams: Props['searchParams']) => (await searchParams) ?? {};

export async function generateMetadata({ params }: Props) {
  // Never throws: an unknown or removed product is the page's 404, not the head's (see
  // `productForMetadata`). A path that will redirect still gets the current path as canonical.
  const product = await productForMetadata((await params).id);
  if (product === undefined) return {};
  const path = productHref(product.id, product.name);
  const description =
    product.description.trim() === ''
      ? await seoDescription('product', {
          name: product.name,
          seller: product.offers[0].seller.name,
        })
      : product.description;
  return pageMetadata({
    name: product.name,
    description,
    path,
    ...(product.photos[0] === undefined ? {} : { image: product.photos[0] }),
  });
}

/**
 * A redirect or a 404 leaves from `resolveProduct`, before anything is sent: the route has no
 * `loading.tsx`, which would flush the shell with a 200 first. What comes after that decision is
 * read inside a Suspense boundary instead, so the skeleton shows while the content and reviews
 * load and the status is already settled.
 */
export default async function ProductRoute({ params, searchParams }: Props) {
  const [{ id }, query] = await Promise.all([params, queryOf(searchParams)]);
  const { product, path } = await resolveProduct(id, query);
  const initialVariantId = variantFromParam(product, query.v);
  const t = await getTranslations('product');
  return (
    <Suspense fallback={<ProductLoading label={t('loading')} />}>
      <ProductContent product={product} path={path} initialVariantId={initialVariantId} />
    </Suspense>
  );
}

async function ProductContent({
  product,
  path,
  initialVariantId,
}: {
  readonly product: ProductDetail;
  readonly path: string;
  readonly initialVariantId: string | undefined;
}) {
  const [content, origin, t, reviews] = await Promise.all([
    loadStorefrontContent(),
    requestOrigin(),
    getTranslations('catalog'),
    // Null while the Market's reviews switch is off, on a fault, and for a product with none.
    loadProductReviews(product.id),
  ]);
  const category = content.categories.find((c) => c.code === product.category);
  // The markup is built from the same read as the page, so price and stock always match it.
  const canonical = origin === undefined ? undefined : canonicalOf({ path }, origin);
  const data =
    origin === undefined || canonical === undefined
      ? null
      : productPageStructuredData(
          product,
          // The visible crumbs, without "Browse products" (a panel, not a page).
          [
            { name: t('home'), path: '/' },
            ...(category ? [{ name: category.name, path: `/c/${category.code}` }] : []),
            { name: product.name },
          ],
          origin,
          canonical,
        );
  return (
    <>
      <JsonLd data={data} />
      <ProductPage
        product={product}
        category={category}
        reviews={reviews}
        initialVariantId={initialVariantId}
      />
    </>
  );
}
