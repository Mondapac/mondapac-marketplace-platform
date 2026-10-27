import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FilterChips } from '../../../../src/catalog/filter-chips.tsx';
import { ListingFilters, SortSelect } from '../../../../src/catalog/listing-controls.tsx';
import {
  activeFilterCount,
  listingHref,
  listingStateOf,
  throughOf,
  withoutFilters,
  withPage,
} from '../../../../src/catalog/listing-state.ts';
import {
  ActiveFilters,
  ListingBannerView,
  NumberedPager,
  ResultCount,
} from '../../../../src/catalog/listing.tsx';
import {
  Crumbs,
  EmptyResults,
  ProductResults,
  ResultsHead,
  type Crumb,
} from '../../../../src/catalog/results.tsx';
import { findProductsThrough } from '../../../../src/catalog/through.ts';
import {
  LISTING_PAGE_SIZE,
  findProducts,
  listingBanner,
  listingFacets,
  listingIsLive,
  resolveCategory,
} from '../../../../src/storefront/catalog.ts';
import { listingNoindex, pageMetadata, seoDescription } from '../../../../src/seo/metadata.ts';

interface Props {
  readonly params: Promise<{ category: string; sub?: string[] }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The category and subcategory of the path; an unknown one is a 404. */
async function resolve(params: Props['params']) {
  const { category: code, sub = [] } = await params;
  if (sub.length > 1) notFound();
  const found = await resolveCategory(code, sub[0]);
  if (!found) notFound();
  return found;
}

export async function generateMetadata({ params, searchParams }: Props) {
  const [{ category, child }, query] = await Promise.all([resolve(params), searchParams]);
  const state = listingStateOf(query);
  const path = child ? `/c/${category.code}/${child.code}` : `/c/${category.code}`;
  const scope = { category: category.code, ...(child ? { subcategory: child.code } : {}) };
  const [all, description] = await Promise.all([
    findProducts({ ...scope, page: 1, pageSize: 1 }),
    child
      ? seoDescription('subcategory', { name: child.name, category: category.name })
      : seoDescription('category', { name: category.name }),
  ]);
  return pageMetadata({
    name: child?.name ?? category.name,
    description,
    path,
    page: state.page,
    // An empty list, or a filtered or re-ordered copy of the plain one, stays out of the index.
    noindex: listingNoindex(state) || (all.total ?? all.items.length) === 0,
  });
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ category, child }, query, t] = await Promise.all([
    resolve(params),
    searchParams,
    getTranslations('catalog'),
  ]);
  const base = `/c/${category.code}`;
  const path = child ? `${base}/${child.code}` : base;
  // With the API on the page lists products only: the route has no filters, sort, total, facets
  // or banners, so those controls are left out and a filter left in the URL matches nothing.
  const live = listingIsLive();
  const state = listingStateOf(query);
  // A phone that pressed Load more has `?through=N`: pages `page` to N are one list.
  const through = throughOf(query, state.page);
  const scope = { category: category.code, ...(child ? { subcategory: child.code } : {}) };
  const [result, facets, banner] = await Promise.all([
    findProductsThrough({ ...scope, ...state, pageSize: LISTING_PAGE_SIZE }, through),
    listingFacets(scope),
    listingBanner(category.code),
  ]);
  const total = result.total ?? 0;
  const pages = Math.ceil(total / LISTING_PAGE_SIZE);
  const filtered = activeFilterCount(state.filters) > 0;
  const title = child?.name ?? category.name;
  const trail: Crumb[] = [
    { label: t('home'), href: '/' },
    { label: t('browse-products'), browse: true },
  ];
  if (child) trail.push({ label: category.name, href: base });

  return (
    <>
      <Crumbs trail={trail} current={title} />
      {banner ? <ListingBannerView banner={banner} /> : null}
      <ResultsHead title={title} {...(result.total === undefined ? {} : { total: result.total })}>
        <FilterChips
          label={t('filter-subcategory', { name: category.name })}
          chips={[
            { label: t('all'), href: base, current: !child },
            ...category.children.map((c) => ({
              label: c.name,
              href: `${base}/${c.code}`,
              current: c.code === child?.code,
            })),
          ]}
        />
      </ResultsHead>
      {live ? null : (
        <>
          <ListingFilters path={path} state={state} facets={facets} total={total} />
          <ActiveFilters path={path} state={state} facets={facets} />
          <div className="rbar">
            <ResultCount
              page={state.page}
              pageSize={LISTING_PAGE_SIZE}
              total={total}
              through={through}
            />
            <SortSelect path={path} state={state} />
          </div>
        </>
      )}
      <ProductResults
        result={result}
        hrefFor={(page) => listingHref(path, withPage(state, page))}
        loadMore={{ scope, state, path, through }}
        {...(live ? {} : { pager: <NumberedPager path={path} state={state} pages={pages} /> })}
        empty={
          filtered ? (
            <EmptyResults message={t('filters-empty')}>
              <p className="hint">{t('filters-empty-hint')}</p>
              <Link className="btn" href={listingHref(path, withoutFilters(state))} scroll={false}>
                {t('clear-filters')}
              </Link>
            </EmptyResults>
          ) : (
            <EmptyResults message={t('category-empty', { name: title })}>
              <div className="actions">
                {child ? (
                  <Link className="btn" href={base}>
                    {t('all-of', { name: category.name })}
                  </Link>
                ) : null}
                <Link className={child ? 'btn alt' : 'btn'} href="/">
                  {t('home-page')}
                </Link>
              </div>
            </EmptyResults>
          )
        }
      />
    </>
  );
}
