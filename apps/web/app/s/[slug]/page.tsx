import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { SellerPage } from '../../../src/seller/seller-page.tsx';
import { SELLER_RATINGS_SHOWN } from '../../../src/storefront/features.ts';
import { loadSeller } from '../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ slug: string }>;
}

/** The seller of the path; an unknown one is a 404. */
async function resolve(params: Props['params']) {
  const { slug } = await params;
  const shop = await loadSeller(slug);
  if (!shop) notFound();
  return shop;
}

export async function generateMetadata({ params }: Props) {
  const [shop, t] = await Promise.all([resolve(params), getTranslations('store')]);
  return { title: `${shop.name} | ${t('title')}` };
}

export default async function SellerRoute({ params }: Props) {
  return <SellerPage shop={await resolve(params)} ratingsShown={SELLER_RATINGS_SHOWN} />;
}
