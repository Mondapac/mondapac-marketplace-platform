import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { UnavailableProductView } from '../../../src/errors/unavailable-product.tsx';
import { ProductPage } from '../../../src/product/product-page.tsx';
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
  const [found, t] = await Promise.all([resolve(params), getTranslations('store')]);
  if (found.product) return { title: `${found.product.name} | ${t('title')}` };
  // A removed product leaves the search index; the page stays for old links.
  return { title: `${found.removed.name} | ${t('title')}`, robots: { index: false } };
}

export default async function ProductRoute({ params }: Props) {
  const found = await resolve(params);
  if (!found.product) return <UnavailableProductView product={found.removed} />;
  const content = await loadStorefrontContent();
  const category = content.categories.find((c) => c.code === found.product.category);
  return <ProductPage product={found.product} category={category} />;
}
