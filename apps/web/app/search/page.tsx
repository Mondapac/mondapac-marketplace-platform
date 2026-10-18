import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import {
  EmptyResults,
  FilterChips,
  ProductResults,
  ResultsHead,
} from '../../src/catalog/results.tsx';
import { SearchRefine } from '../../src/catalog/search-refine.tsx';
import { QUERY_MIN, findProducts, pageOf, queryOf } from '../../src/storefront/catalog.ts';
import { loadStorefrontContent } from '../../src/storefront/source.ts';

interface Props {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function searchHref(q: string, category?: string, page = 1): string {
  const params = new URLSearchParams({ q });
  if (category) params.set('category', category);
  if (page > 1) params.set('page', String(page));
  return `/search?${params.toString()}`;
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
    getTranslations('catalog'),
  ]);
  const q = queryOf(query.q);
  const code = typeof query.category === 'string' ? query.category : undefined;
  const category = content.categories.find((c) => c.code === code);
  const popular = (
    <div className="pchips">
      {content.popularSearches.map((term) => (
        <Link key={term} href={searchHref(term)}>
          {term}
        </Link>
      ))}
    </div>
  );

  if (Array.from(q).length < QUERY_MIN) {
    return (
      <>
        <ResultsHead title={t('search')}>
          <SearchRefine value={q} />
        </ResultsHead>
        <EmptyResults message={t('search-hint', { min: QUERY_MIN })}>
          <h2>{t('popular')}</h2>
          {popular}
        </EmptyResults>
      </>
    );
  }

  const result = await findProducts({
    q,
    ...(category ? { category: category.code } : {}),
    page: pageOf(query.page),
  });
  return (
    <>
      <ResultsHead title={t('results-for', { q })}>
        <SearchRefine value={q} category={category?.code} />
        <FilterChips
          label={t('filter-category')}
          chips={[
            { label: t('all-categories'), href: searchHref(q), current: !category },
            ...content.categories.map((c) => ({
              label: c.shortName,
              href: searchHref(q, c.code),
              current: c.code === category?.code,
            })),
          ]}
        />
      </ResultsHead>
      <ProductResults
        result={result}
        hrefFor={(page) => searchHref(q, category?.code, page)}
        empty={
          <EmptyResults
            message={
              category ? t('no-results-in', { q, name: category.name }) : t('no-results', { q })
            }
          >
            <p className="hint">{t('no-results-hint')}</p>
            {category ? (
              <div className="actions">
                <Link className="btn" href={searchHref(q)}>
                  {t('search-everywhere')}
                </Link>
              </div>
            ) : null}
            <h2>{t('popular')}</h2>
            {popular}
          </EmptyResults>
        }
      />
    </>
  );
}
