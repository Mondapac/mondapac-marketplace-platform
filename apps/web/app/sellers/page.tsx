import { getTranslations } from 'next-intl/server';
import { SELLERS_PAGE_SIZE, SellersPage } from '../../src/sellers/sellers-page.tsx';
import { sellersStateOf } from '../../src/sellers/sellers-state.ts';
import { pageMetadata, sellersNoindex, seoDescription } from '../../src/seo/metadata.ts';
import { SELLER_RATINGS_SHOWN } from '../../src/storefront/features.ts';
import { loadSellers } from '../../src/storefront/source.ts';

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ searchParams }: Props) {
  const [t, description, query] = await Promise.all([
    getTranslations('sellers'),
    seoDescription('sellers'),
    searchParams,
  ]);
  // "Show more" adds stores to the same list, so every page of it has the plain list as canonical.
  return pageMetadata({
    name: t('title'),
    description,
    path: '/sellers',
    noindex: sellersNoindex(sellersStateOf(query, true)),
  });
}

export default async function SellersRoute({ searchParams }: Props) {
  const query = await searchParams;
  // The read knows the buyer's location; Distance and Nearest first count only inside the area,
  // so the state shown is taken again once the location is known.
  const asked = sellersStateOf(query, true);
  const results = await loadSellers({
    filters: asked.filters,
    sort: asked.sort,
    limit: asked.page * SELLERS_PAGE_SIZE,
  });
  const state = sellersStateOf(query, results.location === 'inside');
  return <SellersPage results={results} state={state} ratingsShown={SELLER_RATINGS_SHOWN} />;
}
