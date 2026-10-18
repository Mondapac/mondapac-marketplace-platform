'use client';

import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useEffect, useOptimistic, useRef, useState, useTransition, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Icon } from '../icons/icon.tsx';
import { useStore } from '../shell/store-context.tsx';
import type { ListingFacets } from '../storefront/catalog.ts';
import { priceBandLabel } from './filter-labels.ts';
import {
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

interface Props {
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
export function ListingFilters({ path, state, facets, total }: Props) {
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

  return (
    <>
      <div className="tools" role="group" aria-label={t('quick-filters')}>
        <span className="lbl">{t('filter-by')}</span>
        {quick(
          current.filters.special,
          withFlag(current, 'special', !current.filters.special),
          'tag',
          t('special-prices'),
        )}
        {facets.certifications.map((c) => {
          const on = current.filters.certifications.includes(c.id);
          return quick(on, withValue(current, 'certifications', c.id, !on), 'store', c.name);
        })}
        {quick(
          current.filters.sameDay,
          withFlag(current, 'sameDay', !current.filters.sameDay),
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
      <FiltersDrawer path={path} state={state} facets={facets} total={total} />
    </>
  );
}

function FiltersDrawer({ path, state, facets, total }: Props) {
  const t = useTranslations('catalog');
  const locale = useLocale();
  const { filtersOpen: open, setFiltersOpen } = useStore();
  const { current, pending, apply } = useApply(path, state);
  const [mounted, setMounted] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const opener = useRef<Element | null>(null);

  useEffect(() => setMounted(true), []);
  // Leaving the listing closes the drawer, so it never stays open over another page.
  useEffect(() => () => setFiltersOpen(false), [setFiltersOpen]);

  useEffect(() => {
    if (!open) return;
    opener.current = document.activeElement;
    panel.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setFiltersOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener.current instanceof HTMLElement) opener.current.focus({ preventScroll: true });
    };
  }, [open, setFiltersOpen]);

  const close = () => setFiltersOpen(false);

  const option = (key: string, label: string, count: number, on: boolean, next: ListingState) => (
    // An option with nothing in it cannot be ticked (a dead end); a ticked one can always go.
    <label key={key} className="opt">
      <input
        type="checkbox"
        checked={on}
        disabled={count === 0 && !on}
        onChange={() => apply(next)}
      />
      <span>{label}</span>
      <small className="num">{count}</small>
    </label>
  );
  const flag = (key: FilterFlag, label: string, count: number) =>
    option(key, label, count, current.filters[key], withFlag(current, key, !current.filters[key]));
  const value = (group: FilterGroup, id: string, label: string, count: number) => {
    const on = current.filters[group].includes(id);
    return option(`${group}:${id}`, label, count, on, withValue(current, group, id, !on));
  };

  if (!mounted) return null;
  return createPortal(
    <div className={open ? 'fwrap open' : 'fwrap'}>
      <div className="fscrim" onClick={close} />
      <aside
        className="fpanel"
        id="filters-panel"
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby="filters-title"
        inert={!open}
      >
        <div className="phd">
          <h2 id="filters-title">{t('filters')}</h2>
          <button className="iconbtn" type="button" aria-label={t('close-filters')} onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        <div className="fb" aria-busy={pending}>
          <Group title={t('group-offers')} open>
            {flag('special', t('special-prices'), facets.special)}
            {facets.certifications.map((c) =>
              value('certifications', c.id, t('certified', { name: c.name }), c.count),
            )}
            {flag('lowStock', t('low-stock'), facets.lowStock)}
          </Group>
          <Group title={t('group-delivery')} open>
            {flag('sameDay', t('same-day-delivery'), facets.sameDay)}
          </Group>
          <Group title={t('group-seller')}>
            {facets.sellers.map((s) => value('sellers', s.id, s.name, s.count))}
          </Group>
          <Group title={t('group-price')}>
            {facets.prices.map((p) =>
              value('prices', p.id, priceBandLabel(p.band, t, locale), p.count),
            )}
          </Group>
        </div>
        <div className="ff">
          <button
            className="btn ghost"
            type="button"
            onClick={() => apply(withoutFilters(current))}
            disabled={activeFilterCount(current.filters) === 0}
          >
            {t('clear-all')}
          </button>
          <button className="btn" type="button" onClick={close} disabled={pending}>
            {t('show-results', { count: total })}
          </button>
        </div>
      </aside>
    </div>,
    document.body,
  );
}

function Group({
  title,
  open = false,
  children,
}: {
  readonly title: string;
  readonly open?: boolean;
  readonly children: ReactNode;
}) {
  return (
    <details className="fg" open={open}>
      <summary>
        {title}
        <Icon name="chevd" />
      </summary>
      <div className="opts">{children}</div>
    </details>
  );
}

/** "Sort by" as a compact select; a change loads the listing in that order from page 1. */
export function SortSelect({ path, state }: Pick<Props, 'path' | 'state'>) {
  const t = useTranslations('catalog');
  const { current, apply } = useApply(path, state);
  return (
    <label className="sortw">
      {t('sort-by')}
      <span className="sel">
        <select
          value={current.sort}
          onChange={(event) => apply(withSort(current, event.target.value as Sort))}
        >
          {SORTS.map((sort) => (
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
