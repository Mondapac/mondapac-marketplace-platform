import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { UnavailableProductView } from '../../../src/errors/unavailable-product.tsx';
import { ProductPage } from '../../../src/product/product-page.tsx';
import { JsonLd } from '../../../src/seo/json-ld.tsx';
import {
  canonicalOf,
  pageMetadata,
  requestOrigin,
  seoDescription,
} from '../../../src/seo/metadata.ts';
import { productPageStructuredData } from '../../../src/seo/structured-data.ts';
import {
  loadProduct,
  loadStorefrontContent,
  loadUnavailableProduct,
} from '../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ id: string }>;
}

// The current path; a later URL shape changes only this line (SEO plan, package 5).
const productPath = (id: string) => `/p/${encodeURIComponent(id)}`;

/** The product of the path, or a removed product; an unknown one is a 404. */
async function resolve(params: Props['params']) {
  const { id } = await params;
  const product = await loadProduct(id);
  if (product) return { product } as const;
  const removed = await loadUnavailableProduct(id);
  if (!removed) notFound();
  return { removed } as const;
}

export async function generateMetadata({ params }: Props) {
  const [found, { id }] = await Promise.all([resolve(params), params]);
  const path = productPath(id);
  if (found.product) {
    const { product } = found;
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
  // A removed product leaves the search index; the page stays for old links.
  return pageMetadata({
    name: found.removed.name,
    description: await seoDescription('unavailable-product', { name: found.removed.name }),
    path,
    noindex: true,
  });
}

export default async function ProductRoute({ params }: Props) {
  const [found, { id }] = await Promise.all([resolve(params), params]);
  // A removed product is noindex: no structured data.
  if (!found.product) return <UnavailableProductView product={found.removed} />;
  const [content, origin, t] = await Promise.all([
    loadStorefrontContent(),
    requestOrigin(),
    getTranslations('catalog'),
  ]);
  const { product } = found;
  const category = content.categories.find((c) => c.code === product.category);
  // The markup is built from the same read as the page, so price and stock always match it.
  const canonical =
    origin === undefined ? undefined : canonicalOf({ path: productPath(id) }, origin);
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
      <ProductPage product={product} category={category} />
    </>
  );
}
