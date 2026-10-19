import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ProductPage } from '../../../src/product/product-page.tsx';
import { loadProduct, loadStorefrontContent } from '../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ id: string }>;
}

/** The product of the path; an unknown one is a 404. */
async function resolve(params: Props['params']) {
  const { id } = await params;
  const product = await loadProduct(id);
  if (!product) notFound();
  return product;
}

export async function generateMetadata({ params }: Props) {
  const [product, t] = await Promise.all([resolve(params), getTranslations('store')]);
  return { title: `${product.name} | ${t('title')}` };
}

export default async function ProductRoute({ params }: Props) {
  const [product, content] = await Promise.all([resolve(params), loadStorefrontContent()]);
  const category = content.categories.find((c) => c.code === product.category);
  return <ProductPage product={product} category={category} />;
}
