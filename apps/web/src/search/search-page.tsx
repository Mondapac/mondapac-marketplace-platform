import { useTranslations } from 'next-intl';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { ListingFilters, SortSelect } from '../catalog/listing-controls.tsx';
import {
  activeFilterCount,
  listingHref,
  withoutFilters,
  type ListingState,
} from '../catalog/listing-state.ts';
import { ActiveFilters, NumberedPager, ResultCount } from '../catalog/listing.tsx';
import { ProductResults } from '../catalog/results.tsx';
import { StoreCard } from '../sellers/store-card.tsx';
import type {
  CategoryCount,
  ListingFacets,
  ProductPage,
  StoreResults,
} from '../storefront/catalog.ts';
import type { Category } from '../storefront/types.ts';
import { FocusResultsHeading, RESULTS_HEADING_ID } from './search-focus.tsx';
import { SearchMessage } from './search-message.tsx';
import { SearchTabs, type ResultTab } from './search-tabs.tsx';

// The search results page (approved design search-a-teal v4): the heading with the product and
// store counts, the Products and Stores tabs, and on Products the categories the results fall
// in, the listing's filters, sort, grid and numbered pager. There is no breadcrumb and no
// Recipes tab (john). "Did you mean" waits for a spelling suggestion from the API.

export const SEARCH_PATH = '/search';

/** The results URL of the search words, optionally narrowed to a category. */
export function searchHref(q: string, category?: string): string {
  const params = new URLSearchParams({ q });
  if (category) params.set('category', category);
  return `${SEARCH_PATH}?${params.toString()}`;
}

/** The results heading, "Results for “words”", which a search sent from a form focuses. */
export function ResultsHeading({ query }: { readonly query: string }) {
  const t = useTranslations('search-results');
  return (
    <h1 id={RESULTS_HEADING_ID} tabIndex={-1}>
      {t.rich('heading', { query, q: (chunks) => <q>{chunks}</q> })}
    </h1>
  );
}

function TermLinks({ terms }: { readonly terms: readonly string[] }) {
  return (
    <div className="row">
      {terms.map((term) => (
        <Link key={term} href={searchHref(term)}>
          {term}
        </Link>
      ))}
    </div>
  );
}

/** Before a search: an empty box, or fewer letters than the API takes. */
export function SearchPrompt({
  query,
  min,
  popular,
}: {
  readonly query: string;
  readonly min: number;
  readonly popular: readonly string[];
}) {
  const t = useTranslations('search-results');
  if (query === '')
    return (
      <div className="sr">
        <h1 id={RESULTS_HEADING_ID} tabIndex={-1}>
          {t('title')}
        </h1>
        <FocusResultsHeading />
        <SearchMessage icon="search" title={t('start-title')} body={t('start-body')}>
          {popular.length > 0 ? <TermLinks terms={popular} /> : null}
        </SearchMessage>
      </div>
    );
  return (
    <div className="sr">
      <ResultsHeading query={query} />
      <FocusResultsHeading />
      <SearchMessage
        icon="info"
        title={t('short-title', { min })}
        body={t('short-body')}
        live="status"
      />
    </div>
  );
}

/** The nothing-found message: spelling tips, popular searches and categories to browse. */
function NoResults({
  query,
  popular,
  categories,
}: {
  readonly query: string;
  readonly popular: readonly string[];
  readonly categories: readonly Category[];
}) {
  const t = useTranslations('search-results');
  return (
    <SearchMessage icon="search" title={t('none-title', { query })}>
      <ul>
        <li>{t('tip-spelling')}</li>
        <li>{t('tip-fewer')}</li>
        <li>{t('tip-kind')}</li>
      </ul>
      {popular.length > 0 ? (
        <>
          <h3>{t('popular')}</h3>
          <TermLinks terms={popular} />
        </>
      ) : null}
      {categories.length > 0 ? (
        <>
          <h3>{t('browse')}</h3>
          <div className="row">
            {categories.slice(0, 6).map((c) => (
              <Link key={c.code} href={`/c/${c.code}`}>
                {c.shortName}
              </Link>
            ))}
          </div>
        </>
      ) : null}
    </SearchMessage>
  );
}

export interface SearchResultsProps {
  readonly query: string;
  /** The category the products are narrowed to, from "In categories". */
  readonly category?: Category;
  readonly categories: readonly Category[];
  /** The categories of every product matching the words, most results first. */
  readonly counts: readonly CategoryCount[];
  readonly state: ListingState;
  readonly products: ProductPage;
  readonly pageSize: number;
  readonly facets: ListingFacets;
  readonly stores: StoreResults;
  readonly tab: ResultTab;
  readonly popular: readonly string[];
  readonly ratingsShown: boolean;
}

export function SearchResults(props: SearchResultsProps) {
  const t = useTranslations('search-results');
  const { query, counts, stores, categories } = props;
  const productCount = counts.reduce((sum, c) => sum + c.count, 0);
  const storeCount = stores.items.length;

  if (productCount === 0 && storeCount === 0)
    return (
      <div className="sr">
        <ResultsHeading query={query} />
        <FocusResultsHeading />
        <NoResults query={query} popular={props.popular} categories={categories} />
      </div>
    );

  // With no products the Stores tab opens; Products stays to show that none match.
  const tab = productCount === 0 ? 'stores' : storeCount === 0 ? 'products' : props.tab;
  return (
    <div className="sr">
      <div>
        <ResultsHeading query={query} />
        <p className="sr-sub num">{t('summary', { products: productCount, stores: storeCount })}</p>
      </div>
      <FocusResultsHeading />
      <SearchTabs
        key={query}
        initial={tab}
        counts={{ products: productCount, stores: storeCount }}
        panels={{
          products: <ProductsPanel {...props} />,
          stores: <StoresPanel query={query} stores={stores} ratingsShown={props.ratingsShown} />,
        }}
      />
    </div>
  );
}

export interface LiveSearchResultsProps {
  readonly query: string;
  readonly category?: Category;
  readonly categories: readonly Category[];
  readonly state: ListingState;
  readonly products: ProductPage;
  /** What the filters offer, which is nothing with the API on; only the category chip uses it. */
  readonly facets: ListingFacets;
  readonly popular: readonly string[];
}

/**
 * The results with the API on: the heading and the product grid with previous and next. The
 * search route gives no counts, filters, sort, store search or categories of the results, so the
 * count line, the Products and Stores tabs, "In categories" and the filter controls are left
 * out rather than shown from the sample. A filter left in a shared URL has matched nothing, and
 * says so.
 */
export function LiveSearchResults({
  query,
  category,
  categories,
  state,
  products,
  facets,
  popular,
}: LiveSearchResultsProps) {
  const t = useTranslations('search-results');
  const tc = useTranslations('catalog');
  const path = searchHref(query, category?.code);
  const filtered = activeFilterCount(state.filters) > 0;
  return (
    <div className="sr">
      <ResultsHeading query={query} />
      <FocusResultsHeading />
      {category ? (
        <ActiveFilters
          path={path}
          state={withoutFilters(state)}
          facets={facets}
          extra={[
            {
              key: 'category',
              label: t('category-filter', { name: category.shortName }),
              href: searchHref(query),
            },
          ]}
          clearHref={searchHref(query)}
        />
      ) : null}
      <ProductResults
        result={products}
        hrefFor={(page) => listingHref(path, { ...state, page })}
        empty={
          filtered ? (
            <div className="empty rich">
              <p role="status">{tc('filters-empty')}</p>
              <p className="hint">{tc('filters-empty-hint')}</p>
              <Link className="btn" href={listingHref(path, withoutFilters(state))} scroll={false}>
                {tc('clear-filters')}
              </Link>
            </div>
          ) : category ? (
            <div className="empty rich">
              <p role="status">{t('no-products-in', { query, name: category.name })}</p>
              <Link className="btn" href={searchHref(query)}>
                {t('search-everywhere')}
              </Link>
            </div>
          ) : (
            <NoResults query={query} popular={popular} categories={categories} />
          )
        }
      />
    </div>
  );
}

function ProductsPanel({
  query,
  category,
  categories,
  counts,
  state,
  products,
  pageSize,
  facets,
}: SearchResultsProps) {
  const t = useTranslations('search-results');
  const tc = useTranslations('catalog');
  const path = searchHref(query, category?.code);
  const total = products.total ?? 0;
  const filtered = activeFilterCount(state.filters) > 0;
  const shown = counts.slice(0, 4).flatMap((c) => {
    const found = categories.find((k) => k.code === c.code);
    return found ? [{ ...c, name: found.shortName }] : [];
  });

  if (counts.length === 0)
    return (
      <div className="empty rich">
        <p role="status">{t('no-products', { query })}</p>
      </div>
    );

  return (
    <>
      {!category && shown.length >= 2 ? (
        <div className="sr-cats" role="group" aria-labelledby="sr-cats-label">
          <span className="lbl" id="sr-cats-label">
            {t('in-categories')}
          </span>
          {shown.map((c) => (
            <Link key={c.code} href={searchHref(query, c.code)}>
              {t('category-count', { name: c.name, count: c.count })}
            </Link>
          ))}
        </div>
      ) : null}
      <ListingFilters kind="search" path={path} state={state} facets={facets} total={total} />
      <ActiveFilters
        path={path}
        state={state}
        facets={facets}
        extra={
          category
            ? [
                {
                  key: 'category',
                  label: t('category-filter', { name: category.shortName }),
                  href: listingHref(searchHref(query), { ...state, page: 1 }),
                },
              ]
            : []
        }
        {...(category ? { clearHref: searchHref(query) } : {})}
      />
      <div className="rbar">
        <ResultCount page={state.page} pageSize={pageSize} total={total} />
        <SortSelect kind="search" path={path} state={state} />
      </div>
      <ProductResults
        result={products}
        hrefFor={(page) => listingHref(path, { ...state, page })}
        pager={<NumberedPager path={path} state={state} pages={Math.ceil(total / pageSize)} />}
        empty={
          filtered ? (
            <div className="empty rich">
              <p role="status">{tc('filters-empty')}</p>
              <p className="hint">{tc('filters-empty-hint')}</p>
              <Link className="btn" href={listingHref(path, withoutFilters(state))} scroll={false}>
                {tc('clear-filters')}
              </Link>
            </div>
          ) : (
            <div className="empty rich">
              <p role="status">
                {category
                  ? t('no-products-in', { query, name: category.name })
                  : t('no-products', { query })}
              </p>
              {category ? (
                <Link className="btn" href={searchHref(query)}>
                  {t('search-everywhere')}
                </Link>
              ) : null}
            </div>
          )
        }
      />
    </>
  );
}

function StoresPanel({
  query,
  stores,
  ratingsShown,
}: {
  readonly query: string;
  readonly stores: StoreResults;
  readonly ratingsShown: boolean;
}) {
  const t = useTranslations('search-results');
  if (stores.items.length === 0)
    return (
      <div className="empty rich">
        <p role="status">{t('no-stores', { query })}</p>
      </div>
    );
  return (
    <>
      <h2 className="sr-only">{t('stores')}</h2>
      <div className="sl-grid">
        {stores.items.map((store) => (
          <StoreCard
            key={store.id}
            store={store}
            location={stores.location}
            ratingsShown={ratingsShown}
          />
        ))}
      </div>
    </>
  );
}

/** The loading state, shaped like the results: count line, tabs, filters, result bar, 12 cards. */
export function SearchLoading({
  heading,
  label,
}: {
  readonly heading: ReactNode;
  readonly label: string;
}) {
  return (
    <div className="sr">
      {heading}
      <div className="sr-sk" role="status" aria-busy="true" aria-label={label}>
        <i className="sk-sub" />
        <div className="sk-tabs">
          <i />
          <i />
        </div>
        <div className="sk-tools">
          <i className="w1" />
          <i className="w2" />
          <i className="w3" />
          <i className="w4" />
        </div>
        <div className="sk-rbar">
          <i className="w5" />
          <i className="w6" />
        </div>
        <div className="grid">
          {Array.from({ length: 12 }, (_, i) => (
            <div key={i} className="sk-c">
              <i className="sk-t" />
              <i className="l1" />
              <i className="l2" />
              <i className="l3" />
              <i className="l4" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
