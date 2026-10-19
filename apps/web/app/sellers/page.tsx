import { getTranslations } from 'next-intl/server';
import { SELLERS_PAGE_SIZE, SellersPage } from '../../src/sellers/sellers-page.tsx';
import { sellersStateOf } from '../../src/sellers/sellers-state.ts';
import { SELLER_RATINGS_SHOWN } from '../../src/storefront/features.ts';
import { loadSellers } from '../../src/storefront/source.ts';

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata() {
  const [t, ts] = await Promise.all([getTranslations('store'), getTranslations('sellers')]);
  return { title: `${ts('title')} | ${t('title')}` };
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
