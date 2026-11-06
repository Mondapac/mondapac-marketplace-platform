'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useOptimistic, useState, useTransition } from 'react';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { LiveFilterGroup } from '../storefront/listing-source.ts';
import { priceBandLabel } from './filter-labels.ts';
import { FilterGroupView, FilterOption, FiltersDrawerFrame } from './filters-drawer.tsx';
import {
  NO_LIVE_FILTERS,
  liveFilterCount,
  livePriceBands,
  samePrice,
  withChoice,
  withLiveParams,
  withLivePrice,
  type LiveFilters,
} from './live-filters.ts';
import { listingHref, type ListingState } from './listing-state.ts';

// The filters of a listing that reads the API (attributes A7, variants V8): the category's
// attribute filters as the API offers and counts them (variant axes such as size or colour
// included), and price bands in the listing's currency. A change loads the listing from page 1 at
// once, as the sample's drawer does (./listing-controls.tsx).

interface Props {
  /** The listing's address without the live filters (it may carry `direct=1` or the words). */
  readonly path: string;
  readonly state: ListingState;
  readonly filters: LiveFilters;
  readonly groups: readonly LiveFilterGroup[];
  /** The currency of the listing's prices; no price bands without one. */
  readonly currency?: string;
}

function useApplyLive(path: string, state: ListingState, filters: LiveFilters) {
  const router = useRouter();
  const [optimistic, setOptimistic] = useOptimistic(filters);
  const [pending, startTransition] = useTransition();
  const apply = (next: LiveFilters) =>
    startTransition(() => {
      setOptimistic(next);
      router.replace(listingHref(withLiveParams(path, next), { ...state, page: 1 }), {
        scroll: false,
      });
    });
  return { current: optimistic, pending, apply };
}

/** "Filter by:" with the "All filters" button, and its drawer; nothing when nothing can filter. */
export function LiveListingFilters(props: Props) {
  if (props.groups.length === 0 && props.currency === undefined) return null;
  return <LiveFiltersBar {...props} />;
}

function LiveFiltersBar({ path, state, filters, groups, currency }: Props) {
  const t = useTranslations('catalog');
  const locale = useLocale();
  const { filtersOpen, setFiltersOpen } = useStore();
  const { current, pending, apply } = useApplyLive(path, state, filters);
  const count = liveFilterCount(current);
  // Open when the page came with a price, and never closed under the buyer while they change it:
  // the value is fixed at mount, so a later render does not touch the group's open state.
  const [priceOpen] = useState(filters.price !== null);
  const bands = currency === undefined ? [] : livePriceBands(currency);
  const picked = (attr: string, code: string) =>
    current.choices.find((c) => c.attr === attr)?.values.includes(code) === true;

  return (
    <>
      <div className="tools" role="group" aria-label={t('quick-filters')}>
        <span className="lbl">{t('filter-by')}</span>
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
      <FiltersDrawerFrame
        pending={pending}
        footer={
          <>
            <button
              className="btn ghost"
              type="button"
              onClick={() => apply(NO_LIVE_FILTERS)}
              disabled={count === 0}
            >
              {t('clear-all')}
            </button>
            <button
              className="btn"
              type="button"
              onClick={() => setFiltersOpen(false)}
              disabled={pending}
            >
              {t('show-results-any')}
            </button>
          </>
        }
      >
        {groups.map((group, index) => (
          <FilterGroupView key={group.code} title={group.name} open={index < 2}>
            {group.options.map((option) => {
              const on = picked(group.code, option.code);
              return (
                <FilterOption
                  key={option.code}
                  label={group.kind === 'toggle' ? group.name : option.label}
                  count={option.count}
                  on={on}
                  onChange={() => apply(withChoice(current, group.code, option.code, !on))}
                />
              );
            })}
          </FilterGroupView>
        ))}
        {bands.length === 0 ? null : (
          <FilterGroupView title={t('group-price')} open={priceOpen}>
            {bands.map(({ band, price }) => {
              const on = samePrice(current.price, price);
              return (
                <FilterOption
                  key={band.id}
                  label={priceBandLabel(band, t, locale)}
                  on={on}
                  onChange={() => apply(withLivePrice(current, on ? null : price))}
                />
              );
            })}
          </FilterGroupView>
        )}
      </FiltersDrawerFrame>
    </>
  );
}
