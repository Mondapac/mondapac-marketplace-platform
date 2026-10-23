import { notFound } from 'next/navigation';
import { UnavailableProductView } from '../../../src/errors/unavailable-product.tsx';
import { ProductPage } from '../../../src/product/product-page.tsx';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
import {
  loadProduct,
  loadStorefrontContent,
  loadUnavailableProduct,
} from '../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ id: string }>;
}

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
  // The current path; a later URL shape changes only this line (SEO plan, package 5).
  const path = `/p/${encodeURIComponent(id)}`;
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
  const found = await resolve(params);
  if (!found.product) return <UnavailableProductView product={found.removed} />;
  const content = await loadStorefrontContent();
  const category = content.categories.find((c) => c.code === found.product.category);
  return <ProductPage product={found.product} category={category} />;
}
