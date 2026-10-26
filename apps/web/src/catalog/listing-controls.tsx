'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useOptimistic, useTransition } from 'react';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { ListingFacets } from '../storefront/catalog.ts';
import { priceBandLabel } from './filter-labels.ts';
import { FilterGroupView, FilterOption, FiltersDrawerFrame } from './filters-drawer.tsx';
import {
  SEARCH_SORTS,
  SORTS,
  activeFilterCount,
  listingHref,
  withFlag,
  withSort,
  withValue,
  withoutFilters,
  type FilterFlag,
  type FilterGroup,
  type ListingState,
  type Sort,
} from './listing-state.ts';

/** The category listing, or the Products tab of the search results (a smaller set of filters). */
export type ListingKind = 'category' | 'search';

interface Props {
  readonly kind?: ListingKind;
  readonly path: string;
  readonly state: ListingState;
  readonly facets: ListingFacets;
  /** Matching products under the current filters. */
  readonly total: number;
}

/** Loads the listing for a new filter or sort state, keeping the scroll position. */
function useApply(path: string, state: ListingState) {
  const router = useRouter();
  const [optimistic, setOptimistic] = useOptimistic(state);
  const [pending, startTransition] = useTransition();
  const apply = (next: ListingState) =>
    startTransition(() => {
      setOptimistic(next);
      router.replace(listingHref(path, next), { scroll: false });
    });
  return { current: optimistic, pending, apply };
}

/**
 * "Filter by:" with the quick chips (toggle buttons) and the "All filters" button with its
 * right-hand drawer (380px, a dialog: Esc and the scrim close it, focus goes back to the
 * button). A change applies at once; the drawer's footer button shows how many products the
 * filters leave.
 */
export function ListingFilters({ kind = 'category', path, state, facets, total }: Props) {
  const t = useTranslations('catalog');
  const { filtersOpen, setFiltersOpen } = useStore();
  const { current, apply } = useApply(path, state);
  const count = activeFilterCount(current.filters);
  const quick = (
    on: boolean,
    next: ListingState,
    icon: 'tag' | 'store' | 'bolt',
    label: string,
  ) => (
    <button
      key={label}
      className="chip"
      type="button"
      aria-pressed={on}
      onClick={() => apply(next)}
    >
      <Icon name={icon} />
      {label}
    </button>
  );
  const special = quick(
    current.filters.special,
    withFlag(current, 'special', !current.filters.special),
    'tag',
    t('special-prices'),
  );
  const certifications = facets.certifications.map((c) => {
    const on = current.filters.certifications.includes(c.id);
    return quick(on, withValue(current, 'certifications', c.id, !on), 'store', c.name);
  });

  return (
    <>
      <div className="tools" role="group" aria-label={t('quick-filters')}>
        <span className="lbl">{t('filter-by')}</span>
        {kind === 'search' ? (
          <>
            {certifications}
            {special}
          </>
        ) : (
          <>
            {special}
            {certifications}
            {quick(
              current.filters.sameDay,
              withFlag(current, 'sameDay', !current.filters.sameDay),
              'bolt',
              t('same-day'),
            )}
          </>
        )}
        <SortSelect kind={kind} path={path} state={state} inBar />
        <button
          className="chip all"
          type="button"
          aria-haspopup="dialog"
          aria-controls="filters-panel"
          aria-expanded={filtersOpen}
          onClick={() => setFiltersOpen(true)}
        >
          <Icon name="menu" />
          {t('all-filters')}
          {count > 0 ? (
            <span className="n num">
              <span aria-hidden="true">{count}</span>
              <span className="sr-only">{t('filters-on', { count })}</span>
            </span>
          ) : null}
        </button>
      </div>
      <FiltersDrawer kind={kind} path={path} state={state} facets={facets} total={total} />
    </>
  );
}

function FiltersDrawer({ kind, path, state, facets, total }: Props) {
  const t = useTranslations('catalog');
  const locale = useLocale();
  const { setFiltersOpen } = useStore();
  const { current, pending, apply } = useApply(path, state);

  const option = (key: string, label: string, count: number, on: boolean, next: ListingState) => (
    <FilterOption key={key} label={label} count={count} on={on} onChange={() => apply(next)} />
  );
  const flag = (key: FilterFlag, label: string, count: number) =>
    option(key, label, count, current.filters[key], withFlag(current, key, !current.filters[key]));
  const value = (group: FilterGroup, id: string, label: string, count: number) => {
    const on = current.filters[group].includes(id);
    return option(`${group}:${id}`, label, count, on, withValue(current, group, id, !on));
  };

  const sellers = facets.sellers.map((s) => value('sellers', s.id, s.name, s.count));
  const prices = (open: boolean) => (
    <FilterGroupView title={t('group-price')} open={open}>
      {facets.prices.map((p) => value('prices', p.id, priceBandLabel(p.band, t, locale), p.count))}
    </FilterGroupView>
  );

  return (
    <FiltersDrawerFrame
      pending={pending}
      footer={
        <>
          <button
            className="btn ghost"
            type="button"
            onClick={() => apply(withoutFilters(current))}
            disabled={activeFilterCount(current.filters) === 0}
          >
            {t('clear-all')}
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => setFiltersOpen(false)}
            disabled={pending}
          >
            {t('show-results', { count: total })}
          </button>
        </>
      }
    >
      {kind === 'search' ? (
        <>
          <FilterGroupView title={t('group-labels')} open>
            {facets.certifications.map((c) => value('certifications', c.id, c.name, c.count))}
            {flag('special', t('special-prices'), facets.special)}
          </FilterGroupView>
          {prices(true)}
          <FilterGroupView title={t('group-store')}>{sellers}</FilterGroupView>
        </>
      ) : (
        <>
          <FilterGroupView title={t('group-offers')} open>
            {flag('special', t('special-prices'), facets.special)}
            {facets.certifications.map((c) =>
              value('certifications', c.id, t('certified', { name: c.name }), c.count),
            )}
            {flag('lowStock', t('low-stock'), facets.lowStock)}
          </FilterGroupView>
          <FilterGroupView title={t('group-delivery')} open>
            {flag('sameDay', t('same-day-delivery'), facets.sameDay)}
          </FilterGroupView>
          <FilterGroupView title={t('group-seller')}>{sellers}</FilterGroupView>
          {prices(false)}
        </>
      )}
    </FiltersDrawerFrame>
  );
}

/** "Sort by" as a compact select; a change loads the listing in that order from page 1. */
export function SortSelect({
  kind = 'category',
  path,
  state,
  inBar = false,
}: Pick<Props, 'kind' | 'path' | 'state'> & {
  /** The copy inside the quick-filter bar, which only the phone shows (the result bar has the other). */
  readonly inBar?: boolean;
}) {
  const t = useTranslations('catalog');
  const { current, apply } = useApply(path, state);
  return (
    <label className={inBar ? 'sortw in-bar' : 'sortw'}>
      {t('sort-by')}
      <span className="sel">
        <select
          value={current.sort}
          onChange={(event) => apply(withSort(current, event.target.value as Sort))}
        >
          {(kind === 'search' ? SEARCH_SORTS : SORTS).map((sort) => (
            <option key={sort} value={sort}>
              {kind === 'search' && sort === 'recommended'
                ? t('sort-best-match')
                : t(`sort-${sort}`)}
            </option>
          ))}
        </select>
        <Icon name="chevd" />
      </span>
    </label>
  );
}
