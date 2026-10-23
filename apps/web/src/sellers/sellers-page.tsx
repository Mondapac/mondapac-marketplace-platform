import { useLocale, useTranslations } from 'next-intl';
import Link from 'next/link';
import { BrowseCrumb } from '../catalog/browse-crumb.tsx';
import { Icon } from '../icons/icon.tsx';
import type { SellerResults } from '../storefront/types.ts';
import { SellerSortSelect, SellersFilters, minimumLabel } from './sellers-controls.tsx';
import {
  sellerFilterCount,
  sellersHref,
  withDistance,
  withSellerFlag,
  withSellerValue,
  withSellersPage,
  withoutSellerFilters,
  type SellerGroup,
  type SellersState,
} from './sellers-state.ts';
import { FocusNewStores } from './focus-new.tsx';
import { StoreCard, StoreCardSkeleton } from './store-card.tsx';

// The sellers page (approved design sellers-a-teal v4). There is no visible title: the page opens
// with "All stores", its filters (the product listing's pattern), the count and sort, and the
// store grid, 12 at a time with "Show more". There is no "Closest to you" section (john removed
// it); distance shows only as a filter and a sort, when the buyer's location is in the area.

export const SELLERS_PATH = '/sellers';
export const SELLERS_PAGE_SIZE = 12;

export function SellersPage({
  results,
  state,
  ratingsShown,
}: {
  readonly results: SellerResults;
  readonly state: SellersState;
  readonly ratingsShown: boolean;
}) {
  const t = useTranslations('sellers');
  const tc = useTranslations('catalog');
  const path = SELLERS_PATH;
  const { items, total, facets, location } = results;

  if (results.all === 0)
    return (
      <div className="sl">
        <h1 className="sr-only">{t('title')}</h1>
        <div className="sl-empty">
          <Icon name="store" />
          <h2>{t('none-title')}</h2>
          <p>{t('none-body')}</p>
          <BrowseCrumb className="btn" label={t('browse-products')} />
        </div>
      </div>
    );

  const rest = total - items.length;
  return (
    <div className="sl">
      <h1 className="sr-only">{t('title')}</h1>
      <section aria-labelledby="sl-all">
        <h2 id="sl-all">{t('all-stores')}</h2>
        {results.filtersOffered === false ? null : (
          <SellersFilters path={path} state={state} facets={facets} total={total} />
        )}
        {/* Without filters on offer, the empty state below is the one way out of an old URL. */}
        {results.filtersOffered === false ? null : (
          <ActiveSellerFilters results={results} state={state} />
        )}
        <div className="rbar">
          <p className="cnt num" aria-live="polite">
            {t('count', { count: total })}
          </p>
          <SellerSortSelect
            path={path}
            state={state}
            nearest={location === 'inside'}
            offered={results.sorts}
          />
        </div>
        {total === 0 ? (
          <div className="empty rich">
            <h3>{t(results.filtersOffered === false ? 'filters-unavailable' : 'filters-empty')}</h3>
            <p className="hint">
              {t(
                results.filtersOffered === false
                  ? 'filters-unavailable-hint'
                  : 'filters-empty-hint',
              )}
            </p>
            <Link
              className="btn"
              href={sellersHref(path, withoutSellerFilters(state))}
              scroll={false}
            >
              {tc('clear-filters')}
            </Link>
          </div>
        ) : (
          <>
            <div className="sl-grid">
              {items.map((store) => (
                <StoreCard
                  key={store.id}
                  store={store}
                  location={location}
                  ratingsShown={ratingsShown}
                />
              ))}
            </div>
            <FocusNewStores first={(state.page - 1) * SELLERS_PAGE_SIZE} />
            {rest > 0 ? (
              <Link
                className="btn ghost sl-more"
                href={sellersHref(path, withSellersPage(state, state.page + 1))}
                scroll={false}
              >
                {t('show-more', { count: rest })}
              </Link>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

/** The removable chips of the filters in use, and "Clear all". */
function ActiveSellerFilters({
  results,
  state,
}: {
  readonly results: SellerResults;
  readonly state: SellersState;
}) {
  const t = useTranslations('sellers');
  const tc = useTranslations('catalog');
  const locale = useLocale();
  const { facets } = results;
  const { filters } = state;
  const path = SELLERS_PATH;
  const chips: { key: string; label: string; href: string }[] = [];
  if (filters.distance !== undefined)
    chips.push({
      key: 'km',
      label: t('within', { km: filters.distance }),
      href: sellersHref(path, withDistance(state, undefined)),
    });
  const group = (key: SellerGroup, label: (id: string) => string) => {
    for (const id of filters[key])
      chips.push({
        key: `${key}:${id}`,
        label: label(id),
        href: sellersHref(path, withSellerValue(state, key, id, false)),
      });
  };
  group('certifications', (id) => facets.certifications.find((c) => c.id === id)?.name ?? id);
  if (filters.sameDay)
    chips.push({
      key: 'sameDay',
      label: tc('same-day'),
      href: sellersHref(path, withSellerFlag(state, 'sameDay', false)),
    });
  if (filters.newSellers)
    chips.push({
      key: 'newSellers',
      label: t('new-sellers'),
      href: sellersHref(path, withSellerFlag(state, 'newSellers', false)),
    });
  group('categories', (id) => facets.categories.find((c) => c.id === id)?.name ?? id);
  group('minimums', (id) => {
    const bucket = facets.minimums.find((m) => m.id === id)?.bucket;
    return bucket ? minimumLabel(bucket, t, locale) : id;
  });

  return (
    <div className="act" aria-label={tc('active-filters')} role="group">
      {chips.map((chip) => (
        <Link
          key={chip.key}
          href={chip.href}
          scroll={false}
          aria-label={tc('remove-filter', { name: chip.label })}
        >
          {chip.label}
          <Icon name="close" />
        </Link>
      ))}
      {sellerFilterCount(filters) > 0 ? (
        <Link className="clr" href={sellersHref(path, withoutSellerFilters(state))} scroll={false}>
          {tc('clear-all')}
        </Link>
      ) : null}
    </div>
  );
}

/** The route's loading state: the heading row and six grey store cards. */
export function SellersLoading({
  title,
  label,
}: {
  readonly title: string;
  readonly label: string;
}) {
  return (
    <div className="sl" role="status" aria-label={label} aria-busy="true">
      <h1 className="sr-only">{title}</h1>
      <div className="skel title" aria-hidden="true" />
      <div className="sl-grid">
        {Array.from({ length: 6 }, (_, i) => (
          <StoreCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
