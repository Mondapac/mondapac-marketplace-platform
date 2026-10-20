import { getTranslations } from 'next-intl/server';
import { SEARCH_SORTS, listingStateOf } from '../../src/catalog/listing-state.ts';
import { Suspense } from 'react';
import {
  ResultsHeading,
  SearchLoading,
  SearchPrompt,
  SearchResults,
} from '../../src/search/search-page.tsx';
import {
  LISTING_PAGE_SIZE,
  QUERY_MIN,
  findProducts,
  findStores,
  listingFacets,
  queryOf,
  searchCategories,
} from '../../src/storefront/catalog.ts';
import { SELLER_RATINGS_SHOWN } from '../../src/storefront/features.ts';
import { loadStorefrontContent } from '../../src/storefront/source.ts';
import type { StorefrontContent } from '../../src/storefront/types.ts';

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ searchParams }: Props) {
  const [query, t, store] = await Promise.all([
    searchParams,
    getTranslations('catalog'),
    getTranslations('store'),
  ]);
  const q = queryOf(query.q);
  const title = Array.from(q).length >= QUERY_MIN ? t('results-for', { q }) : t('search');
  // Result pages stay out of search engines; categories are the indexable lists.
  return { title: `${title} | ${store('title')}`, robots: { index: false } };
}

export default async function SearchPage({ searchParams }: Props) {
  const [query, content, t] = await Promise.all([
    searchParams,
    loadStorefrontContent(),
    getTranslations('search-results'),
  ]);
  const q = queryOf(query.q);
  if (Array.from(q).length < QUERY_MIN)
    return <SearchPrompt query={q} min={QUERY_MIN} popular={content.popularSearches} />;

  // A new search shows the loading state; a filter or sort change keeps the results in view.
  return (
    <Suspense
      key={q}
      fallback={<SearchLoading heading={<ResultsHeading query={q} />} label={t('loading')} />}
    >
      <Results q={q} query={query} content={content} />
    </Suspense>
  );
}

async function Results({
  q,
  query,
  content,
}: {
  readonly q: string;
  readonly query: Record<string, string | string[] | undefined>;
  readonly content: StorefrontContent;
}) {
  const code = typeof query.category === 'string' ? query.category : undefined;
  const category = content.categories.find((c) => c.code === code);
  const asked = listingStateOf(query);
  // Search offers fewer orders than a category; any other falls back to Best match.
  const sorted = SEARCH_SORTS.includes(asked.sort)
    ? asked
    : { ...asked, sort: 'recommended' as const };
  const scope = { q, ...(category ? { category: category.code } : {}) };
  const facets = await listingFacets(scope);
  // A store filter left over from another search would only show as a bare id: drop it.
  const shown = {
    ...sorted,
    filters: {
      ...sorted.filters,
      sellers: sorted.filters.sellers.filter((id) => facets.sellers.some((s) => s.id === id)),
    },
  };
  const [products, counts, stores] = await Promise.all([
    findProducts({ ...scope, ...shown, pageSize: LISTING_PAGE_SIZE }),
    searchCategories(q),
    findStores(q),
  ]);
  return (
    <SearchResults
      query={q}
      {...(category ? { category } : {})}
      categories={content.categories}
      counts={counts}
      state={shown}
      products={products}
      pageSize={LISTING_PAGE_SIZE}
      facets={facets}
      stores={stores}
      tab={query.tab === 'stores' ? 'stores' : 'products'}
      popular={content.popularSearches}
      ratingsShown={SELLER_RATINGS_SHOWN}
    />
  );
}
