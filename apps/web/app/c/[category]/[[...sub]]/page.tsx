import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FilterChips } from '../../../../src/catalog/filter-chips.tsx';
import { ListingFilters, SortSelect } from '../../../../src/catalog/listing-controls.tsx';
import {
  activeFilterCount,
  listingHref,
  listingStateOf,
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
import {
  LISTING_PAGE_SIZE,
  findProducts,
  listingBanner,
  listingFacets,
} from '../../../../src/storefront/catalog.ts';
import { loadStorefrontContent } from '../../../../src/storefront/source.ts';

interface Props {
  readonly params: Promise<{ category: string; sub?: string[] }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The category and subcategory of the path; an unknown one is a 404. */
async function resolve(params: Props['params']) {
  const { category: code, sub = [] } = await params;
  const content = await loadStorefrontContent();
  const category = content.categories.find((c) => c.code === code);
  if (!category || sub.length > 1) notFound();
  const child = sub.length === 0 ? undefined : category.children.find((c) => c.code === sub[0]);
  if (sub.length === 1 && !child) notFound();
  return { category, child };
}

export async function generateMetadata({ params }: Props) {
  const { category, child } = await resolve(params);
  const t = await getTranslations('store');
  return { title: `${child?.name ?? category.name} | ${t('title')}` };
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ category, child }, query, t] = await Promise.all([
    resolve(params),
    searchParams,
    getTranslations('catalog'),
  ]);
  const base = `/c/${category.code}`;
  const path = child ? `${base}/${child.code}` : base;
  const state = listingStateOf(query);
  const scope = { category: category.code, ...(child ? { subcategory: child.code } : {}) };
  const [result, facets, banner] = await Promise.all([
    findProducts({ ...scope, ...state, pageSize: LISTING_PAGE_SIZE }),
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
      <ResultsHead title={title}>
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
      <ListingFilters path={path} state={state} facets={facets} total={total} />
      <ActiveFilters path={path} state={state} facets={facets} />
      <div className="rbar">
        <ResultCount page={state.page} pageSize={LISTING_PAGE_SIZE} total={total} />
        <SortSelect path={path} state={state} />
      </div>
      <ProductResults
        result={result}
        hrefFor={(page) => listingHref(path, withPage(state, page))}
        pager={<NumberedPager path={path} state={state} pages={pages} />}
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
