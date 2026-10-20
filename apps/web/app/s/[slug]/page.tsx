import { getTranslations } from 'next-intl/server';
import { notFound } from 'next/navigation';
import { ClosedStoreView } from '../../../src/errors/closed-store.tsx';
import { SellerPage } from '../../../src/seller/seller-page.tsx';
import { SELLER_RATINGS_SHOWN } from '../../../src/storefront/features.ts';
import { loadClosedStore, loadSeller } from '../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ slug: string }>;
}

/** The seller of the path, or a store not taking orders; an unknown one is a 404. */
async function resolve(params: Props['params']) {
  const { slug } = await params;
  const shop = await loadSeller(slug);
  if (shop) return { shop } as const;
  const closed = await loadClosedStore(slug);
  if (!closed) notFound();
  return { closed } as const;
}

export async function generateMetadata({ params }: Props) {
  const [found, t] = await Promise.all([resolve(params), getTranslations('store')]);
  if (found.shop) return { title: `${found.shop.name} | ${t('title')}` };
  // A closed store leaves the search index while it is closed.
  return { title: `${found.closed.name} | ${t('title')}`, robots: { index: false } };
}

export default async function SellerRoute({ params }: Props) {
  const found = await resolve(params);
  if (!found.shop)
    return <ClosedStoreView store={found.closed} ratingsShown={SELLER_RATINGS_SHOWN} />;
  return <SellerPage shop={found.shop} ratingsShown={SELLER_RATINGS_SHOWN} />;
}
