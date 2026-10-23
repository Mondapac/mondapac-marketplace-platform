import { notFound } from 'next/navigation';
import { ClosedStoreView } from '../../../src/errors/closed-store.tsx';
import { SellerPage } from '../../../src/seller/seller-page.tsx';
import { pageMetadata, seoDescription } from '../../../src/seo/metadata.ts';
import { SELLER_RATINGS_SHOWN } from '../../../src/storefront/features.ts';
import { loadClosedStore, loadSeller } from '../../../src/storefront/source.ts';
import { storePageOf } from '../../../src/storefront/store-products.ts';
import type { SellerShop } from '../../../src/storefront/types.ts';

interface Props {
  readonly params: Promise<{ slug: string }>;
  /** `page` pages the Products tab of a real store. */
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** Whether the shop shows at least one product: the sample's list or a real store's page. */
function hasListedProducts(shop: SellerShop): boolean {
  if ((shop.products?.length ?? 0) > 0) return true;
  return shop.storeProducts?.kind === 'ok' && shop.storeProducts.items.length > 0;
}

/** The seller of the path, or a store not taking orders; an unknown one is a 404. */
async function resolve(params: Props['params'], searchParams: Props['searchParams']) {
  const [{ slug }, query] = await Promise.all([params, searchParams]);
  const page = storePageOf(query['page']);
  const shop = await loadSeller(slug, page);
  if (shop) return { shop } as const;
  const closed = await loadClosedStore(slug);
  if (!closed) notFound();
  return { closed } as const;
}

export async function generateMetadata({ params, searchParams }: Props) {
  const [found, { slug }] = await Promise.all([resolve(params, searchParams), params]);
  const path = `/s/${encodeURIComponent(slug)}`;
  if (found.shop) {
    const { shop } = found;
    return pageMetadata({
      name: shop.name,
      description: await seoDescription('seller', {
        name: shop.name,
        location: shop.location,
        // Not known yet from the store read: the description ends after the location.
        about: shop.about ?? '',
      }),
      path,
      // Only a seller with at least one listed product is indexed (SEO plan, decision 5). A failed
      // products read leaves the page out.
      noindex: !hasListedProducts(shop),
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

export default async function SellerRoute({ params, searchParams }: Props) {
  const found = await resolve(params, searchParams);
  if (!found.shop)
    return <ClosedStoreView store={found.closed} ratingsShown={SELLER_RATINGS_SHOWN} />;
  return <SellerPage shop={found.shop} ratingsShown={SELLER_RATINGS_SHOWN} />;
}
