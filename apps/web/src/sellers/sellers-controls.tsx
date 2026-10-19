'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useOptimistic, useTransition } from 'react';
import { FilterGroupView, FilterOption, FiltersDrawerFrame } from '../catalog/filters-drawer.tsx';
import { formatMoney } from '../format/money.ts';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { MinimumBucket, SellerFacets } from '../storefront/types.ts';
import {
  SELLER_SORTS,
  sellerFilterCount,
  sellersHref,
  withDistance,
  withSellerFlag,
  withSellerSort,
  withSellerValue,
  withoutSellerFilters,
  type Distance,
  type SellerFlag,
  type SellerGroup,
  type SellerSort,
  type SellersState,
} from './sellers-state.ts';

// The sellers page's quick filters, All filters drawer and sort, the same pattern as the product
// listing page. Distance and Nearest first exist only when the buyer's location is inside the
// delivery area (the facets then carry distances).

interface Props {
  readonly path: string;
  readonly state: SellersState;
  readonly facets: SellerFacets;
  /** Matching stores under the current filters. */
  readonly total: number;
}

/** Loads the page for a new filter or sort state, keeping the scroll position. */
function useApply(path: string, state: SellersState) {
  const router = useRouter();
  const [optimistic, setOptimistic] = useOptimistic(state);
  const [pending, startTransition] = useTransition();
  const apply = (next: SellersState) =>
    startTransition(() => {
      setOptimistic(next);
      router.replace(sellersHref(path, next), { scroll: false });
    });
  return { current: optimistic, pending, apply };
}

/** "No minimum order" or "Up to A$30". */
export function minimumLabel(
  bucket: MinimumBucket,
  t: ReturnType<typeof useTranslations<'sellers'>>,
  locale: string,
): string {
  return bucket.max
    ? t('up-to', { amount: formatMoney(bucket.max, locale, { whole: true }) })
    : t('no-minimum');
}

export function SellersFilters({ path, state, facets, total }: Props) {
  const t = useTranslations('catalog');
  const { filtersOpen, setFiltersOpen } = useStore();
  const { current, apply } = useApply(path, state);
  const count = sellerFilterCount(current.filters);
  const quick = (on: boolean, next: SellersState, icon: 'store' | 'bolt', label: string) => (
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

  return (
    <>
      <div className="tools" role="group" aria-label={t('quick-filters')}>
        <span className="lbl">{t('filter-by')}</span>
        {facets.certifications.map((c) => {
          const on = current.filters.certifications.includes(c.id);
          return quick(on, withSellerValue(current, 'certifications', c.id, !on), 'store', c.name);
        })}
        {quick(
          current.filters.sameDay,
          withSellerFlag(current, 'sameDay', !current.filters.sameDay),
          'bolt',
          t('same-day'),
        )}
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
      <SellersDrawer path={path} state={state} facets={facets} total={total} />
    </>
  );
}

function SellersDrawer({ path, state, facets, total }: Props) {
  const t = useTranslations('sellers');
  const tc = useTranslations('catalog');
  const locale = useLocale();
  const { setFiltersOpen } = useStore();
  const { current, pending, apply } = useApply(path, state);

  const flag = (key: SellerFlag, label: string, count: number) => (
    <FilterOption
      key={key}
      label={label}
      count={count}
      on={current.filters[key]}
      onChange={() => apply(withSellerFlag(current, key, !current.filters[key]))}
    />
  );
  const value = (group: SellerGroup, id: string, label: string, count: number) => {
    const on = current.filters[group].includes(id);
    return (
      <FilterOption
        key={`${group}:${id}`}
        label={label}
        count={count}
        on={on}
        onChange={() => apply(withSellerValue(current, group, id, !on))}
      />
    );
  };
  // One radius at a time: ticking another replaces it, unticking the one in use clears it.
  const distance = (km: Distance, count: number) => {
    const on = current.filters.distance === km;
    return (
      <FilterOption
        key={`km:${km}`}
        label={t('within', { km })}
        count={count}
        on={on}
        onChange={() => apply(withDistance(current, on ? undefined : km))}
      />
    );
  };

  return (
    <FiltersDrawerFrame
      pending={pending}
      footer={
        <>
          <button
            className="btn ghost"
            type="button"
            onClick={() => apply(withoutSellerFilters(current))}
            disabled={sellerFilterCount(current.filters) === 0}
          >
            {tc('clear-all')}
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => setFiltersOpen(false)}
            disabled={pending}
          >
            {t('show-stores', { count: total })}
          </button>
        </>
      }
    >
      {facets.distances.length > 0 ? (
        <FilterGroupView title={t('group-distance')} open>
          {facets.distances.map((d) => distance(d.km as Distance, d.count))}
        </FilterGroupView>
      ) : null}
      <FilterGroupView title={t('group-labels')} open>
        {facets.certifications.map((c) =>
          value('certifications', c.id, t('certificate-checked', { name: c.name }), c.count),
        )}
        {flag('newSellers', t('new-sellers'), facets.newSellers)}
      </FilterGroupView>
      <FilterGroupView title={tc('group-delivery')} open>
        {flag('sameDay', tc('same-day-delivery'), facets.sameDay)}
      </FilterGroupView>
      <FilterGroupView title={t('group-category')}>
        {facets.categories.map((c) => value('categories', c.id, c.name, c.count))}
      </FilterGroupView>
      <FilterGroupView title={t('group-minimum')}>
        {facets.minimums.map((m) =>
          value('minimums', m.id, minimumLabel(m.bucket, t, locale), m.count),
        )}
      </FilterGroupView>
    </FiltersDrawerFrame>
  );
}

/** "Sort by"; Nearest first only when the buyer's location is inside the delivery area. */
export function SellerSortSelect({
  path,
  state,
  nearest,
}: {
  readonly path: string;
  readonly state: SellersState;
  readonly nearest: boolean;
}) {
  const t = useTranslations('sellers');
  const tc = useTranslations('catalog');
  const { current, apply } = useApply(path, state);
  const sorts = SELLER_SORTS.filter((s) => s !== 'nearest' || nearest);
  return (
    <label className="sortw">
      {tc('sort-by')}
      <span className="sel">
        <select
          value={current.sort}
          onChange={(event) => apply(withSellerSort(current, event.target.value as SellerSort))}
        >
          {sorts.map((sort) => (
            <option key={sort} value={sort}>
              {t(`sort-${sort}`)}
            </option>
          ))}
        </select>
        <Icon name="chevd" />
      </span>
    </label>
  );
}
