import { notFound } from 'next/navigation';
import { ClosedStoreView } from '../../../src/errors/closed-store.tsx';
import { SellerPage } from '../../../src/seller/seller-page.tsx';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
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
  const [found, { slug }] = await Promise.all([resolve(params), params]);
  const path = `/s/${encodeURIComponent(slug)}`;
  if (found.shop) {
    const { shop } = found;
    return pageMetadata({
      name: shop.name,
      description: await seoDescription('seller', {
        name: shop.name,
        location: shop.location,
        about: shop.about,
      }),
      path,
      // Only a seller with at least one listed product is indexed (SEO plan, decision 5).
      noindex: shop.products.length === 0,
      ...(shop.logo === undefined ? {} : { image: shop.logo }),
    });
  }
  // A closed store leaves the search index while it is closed.
  return pageMetadata({
    name: found.closed.name,
    description: await seoDescription('closed-store', { name: found.closed.name }),
    path,
    noindex: true,
  });
}

export default async function SellerRoute({ params }: Props) {
  const found = await resolve(params);
  if (!found.shop)
    return <ClosedStoreView store={found.closed} ratingsShown={SELLER_RATINGS_SHOWN} />;
  return <SellerPage shop={found.shop} ratingsShown={SELLER_RATINGS_SHOWN} />;
}
