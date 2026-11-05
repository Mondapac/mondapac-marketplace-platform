import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { FilterChips, type Chip } from '../../../src/catalog/filter-chips.tsx';
import { ListingFilters, SortSelect } from '../../../src/catalog/listing-controls.tsx';
import {
  activeFilterCount,
  listingHref,
  listingStateOf,
  throughOf,
  withoutFilters,
  withPage,
} from '../../../src/catalog/listing-state.ts';
import {
  ActiveFilters,
  ListingBannerView,
  NumberedPager,
  ResultCount,
} from '../../../src/catalog/listing.tsx';
import {
  Crumbs,
  EmptyResults,
  ProductResults,
  ResultsHead,
  type Crumb,
} from '../../../src/catalog/results.tsx';
import { findProductsThrough } from '../../../src/catalog/through.ts';
import {
  LISTING_PAGE_SIZE,
  categoryIsEmpty,
  childCounts,
  listingBanner,
  listingFacets,
  listingIsLive,
  resolveCategory,
} from '../../../src/storefront/catalog.ts';
import { categoryHref } from '../../../src/storefront/links.ts';
import { JsonLd } from '../../../src/seo/json-ld.tsx';
import {
  canonicalOf,
  listingNoindex,
  pageMetadata,
  requestOrigin,
  seoDescription,
} from '../../../src/seo/metadata.ts';
import {
  breadcrumbStructuredData,
  collectionPageStructuredData,
} from '../../../src/seo/structured-data.ts';

interface Props {
  readonly params: Promise<{ slug: string }>;
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

/** The level whose own products get the "Other {name}" chip (level 3, a category: plan 3). */
const OTHER_DEPTH = 2;

/**
 * The category `/c/<slug>` names, at any depth (categories C6). A slug the tree does not hold is a
 * 404; an old, merged or hidden one never reaches the page: the proxy answers its 301 or 302.
 */
async function resolve(params: Props['params']) {
  const { slug } = await params;
  const found = await resolveCategory(slug);
  if (!found) notFound();
  const current = found.child ?? found.category;
  const facts = found.child === undefined ? found.category.page : undefined;
  // The sample's subcategory: its parent is the trail, it has no children of its own.
  const trail = found.child === undefined ? (facts?.trail ?? []) : [found.category];
  const children = found.child === undefined ? found.category.children : [];
  const scope = {
    category: found.category.code,
    ...(found.child ? { subcategory: found.child.code } : {}),
  };
  return { current, facts, trail, children, scope, parent: trail.at(-1) };
}

/** `?direct=1` on a level-3 category with subcategories: only its own products ("Other"). */
function directOf(
  query: Record<string, string | string[] | undefined>,
  depth: number | undefined,
  children: readonly unknown[],
): boolean {
  return query.direct === '1' && depth === OTHER_DEPTH && children.length > 0;
}

export async function generateMetadata({ params, searchParams }: Props) {
  const [{ current, facts, children, scope, parent }, query] = await Promise.all([
    resolve(params),
    searchParams,
  ]);
  const state = listingStateOf(query);
  const direct = directOf(query, facts?.depth, children);
  const [empty, fallback] = await Promise.all([
    facts?.hasLiveProducts === undefined
      ? categoryIsEmpty(scope)
      : Promise.resolve(!facts.hasLiveProducts),
    parent
      ? seoDescription('subcategory', { name: current.name, category: parent.name })
      : seoDescription('category', { name: current.name }),
  ]);
  return pageMetadata({
    name: facts?.seo?.title ?? current.name,
    description: facts?.seo?.description ?? facts?.shortDescription ?? fallback,
    // Canonical to the plain page: a later page, a filter, another order or "Other" is a view of it.
    path: categoryHref(current.code),
    noindex:
      listingNoindex(state) || state.page > 1 || direct || empty || facts?.seo?.noindex === true,
  });
}

export default async function CategoryPage({ params, searchParams }: Props) {
  const [{ current, facts, trail, children, scope: baseScope, parent }, query, t] =
    await Promise.all([resolve(params), searchParams, getTranslations('catalog')]);
  const path = categoryHref(current.code);
  // With the API on the page lists products only: the route has no filters, sort, total, facets
  // or banners, so those controls are left out and a filter left in the URL matches nothing.
  const live = listingIsLive();
  const state = listingStateOf(query);
  const direct = directOf(query, facts?.depth, children);
  const scope = { ...baseScope, ...(direct ? { direct: true } : {}) };
  // The list's own address: "Other" keeps `direct=1` through its pages, filters and order.
  const listPath = direct ? `${path}?direct=1` : path;
  // A phone that pressed Load more has `?through=N`: pages `page` to N are one list.
  const through = throughOf(query, state.page);
  const [result, facets, banner, origin] = await Promise.all([
    findProductsThrough({ ...scope, ...state, pageSize: LISTING_PAGE_SIZE }, through),
    listingFacets(baseScope),
    listingBanner(baseScope.category),
    requestOrigin(),
  ]);
  // Live counts come with the tree; the sample counts its own products.
  const counts: ReadonlyMap<string, number> | undefined = facts?.childCounts
    ? new Map(Object.entries(facts.childCounts))
    : childCounts(
        current.code,
        children.map((c) => c.code),
      );
  const counted = (count: number | undefined) =>
    count === undefined
      ? {}
      : { count: t('chip-count', { count }), countLabel: t('products-total', { count }) };
  // A chip that would lead to an empty list is left out ("Other" too when nothing is direct).
  const shown = children.filter((child) => counts?.get(child.code) !== 0);
  const other = facts?.depth === OTHER_DEPTH && facts.directCount !== 0;
  const total = result.total ?? 0;
  const pages = Math.ceil(total / LISTING_PAGE_SIZE);
  const filtered = activeFilterCount(state.filters) > 0;
  const crumbs: Crumb[] = [
    { label: t('home'), href: '/' },
    { label: t('browse-products'), browse: true },
    ...trail.map((step) => ({ label: step.name, href: categoryHref(step.code) })),
  ];
  const chips: Chip[] =
    shown.length === 0
      ? []
      : [
          { label: t('all'), href: path, current: !direct },
          ...shown.map((child) => ({
            label: child.name,
            href: categoryHref(child.code),
            current: false,
            ...counted(counts?.get(child.code)),
          })),
          ...(other
            ? [
                {
                  label: t('other-of', { name: current.name }),
                  href: `${path}?direct=1`,
                  current: direct,
                  ...counted(facts.directCount),
                },
              ]
            : []),
        ];
  // The visible crumbs and the page as structured data, only on an indexable page (as in
  // generateMetadata: plain view, page 1, not empty) of a listed host. "Browse products" is a panel.
  const empty = facts?.hasLiveProducts === false || (result.total ?? result.items.length) === 0;
  const indexable =
    !listingNoindex(state) && state.page === 1 && !direct && !empty && facts?.seo?.noindex !== true;
  const canonical = origin === undefined ? undefined : canonicalOf({ path }, origin);
  const structured =
    origin === undefined || canonical === undefined || !indexable
      ? null
      : [
          collectionPageStructuredData({
            name: facts?.seo?.title ?? current.name,
            description: facts?.seo?.description ?? facts?.shortDescription ?? current.name,
            url: canonical,
          }),
          ...[
            breadcrumbStructuredData(
              [
                { name: t('home'), path: '/' },
                ...trail.map((step) => ({ name: step.name, path: categoryHref(step.code) })),
                { name: current.name },
              ],
              origin,
            ),
          ].filter((node) => node !== null),
        ];

  return (
    <>
      <JsonLd data={structured} />
      <Crumbs trail={crumbs} current={current.name} />
      {banner ? <ListingBannerView banner={banner} /> : null}
      <ResultsHead
        title={current.name}
        {...(result.total === undefined ? {} : { total: result.total })}
      >
        {facts?.shortDescription ? (
          <p className="cdesc" dir="auto">
            {facts.shortDescription}
          </p>
        ) : null}
        <FilterChips label={t('filter-subcategory', { name: current.name })} chips={chips} />
      </ResultsHead>
      {live || (empty && !filtered) ? null : (
        <>
          <ListingFilters path={listPath} state={state} facets={facets} total={total} />
          <ActiveFilters path={listPath} state={state} facets={facets} />
          <div className="rbar">
            <ResultCount
              page={state.page}
              pageSize={LISTING_PAGE_SIZE}
              total={total}
              through={through}
            />
            <SortSelect path={listPath} state={state} />
          </div>
        </>
      )}
      <ProductResults
        result={result}
        hrefFor={(page) => listingHref(listPath, withPage(state, page))}
        loadMore={{ scope, state, path: listPath, through }}
        {...(live ? {} : { pager: <NumberedPager path={listPath} state={state} pages={pages} /> })}
        empty={
          filtered ? (
            <EmptyResults message={t('filters-empty')}>
              <p className="hint">{t('filters-empty-hint')}</p>
              <Link
                className="btn"
                href={listingHref(listPath, withoutFilters(state))}
                scroll={false}
              >
                {t('clear-filters')}
              </Link>
            </EmptyResults>
          ) : (
            <EmptyResults
              message={t('category-empty', {
                name: direct ? t('other-of', { name: current.name }) : current.name,
              })}
            >
              <div className="actions">
                {direct ? (
                  <Link className="btn" href={path}>
                    {t('all-of', { name: current.name })}
                  </Link>
                ) : parent ? (
                  <Link className="btn" href={categoryHref(parent.code)}>
                    {t('all-of', { name: parent.name })}
                  </Link>
                ) : null}
                <Link className={direct || parent ? 'btn alt' : 'btn'} href="/">
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
