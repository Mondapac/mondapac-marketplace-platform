'use client';

import {
  Badge,
  Button,
  EmptyState,
  LoadError,
  SearchSelect,
  SkeletonRows,
  TextField,
  toast,
  type SearchSelectOption,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { AddAttributeDialog } from './add-attribute-dialog.tsx';
import { AttributeDetailPanel } from './attribute-detail.tsx';
import { useSelectLabels } from './select-labels.ts';
import {
  API_ATTRIBUTES,
  DATA_TYPES,
  PAGE_SIZE,
  STATUSES,
  languageName,
  textIn,
  type AttributePage,
  type AttributeRow,
  type MarketLocales,
} from './types.ts';

type Load = 'loading' | 'ready' | 'failed';

interface Filters {
  readonly search: string;
  readonly type: string;
  readonly status: string;
  readonly usedIn: string;
  readonly missing: string;
}

const NO_FILTERS: Filters = { search: '', type: '', status: '', usedIn: '', missing: '' };

/**
 * The Attributes tab: the filters (search, type, status, feature set, missing language), the list
 * and, beside it, the chosen attribute. The list reads 50 rows at a time; "Show more" reads the
 * next page. Names show in the Market's default language.
 */
export function AttributesTab({
  selectedId,
  onSelect,
  canEdit = false,
  canRestructure = false,
  csrfToken = '',
  onOpenWaiting,
}: {
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly canEdit?: boolean;
  readonly canRestructure?: boolean;
  readonly csrfToken?: string;
  /** Opens the Waiting for you tab (a request is already open there). */
  readonly onOpenWaiting?: () => void;
}) {
  const t = useTranslations('attributes');
  const tl = useTranslations('load');
  const [typed, setTyped] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [rows, setRows] = useState<readonly AttributeRow[]>([]);
  const [page, setPage] = useState<AttributePage | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [more, setMore] = useState(false);
  const [adding, setAdding] = useState(false);
  const latest = useRef(0);

  // The search acts after a short pause.
  useEffect(() => {
    const timer = setTimeout(
      () =>
        setFilters((current) =>
          // Same text: keep the same object, or the list reloads from page 1 for nothing.
          current.search === typed.trim() ? current : { ...current, search: typed.trim() },
        ),
      300,
    );
    return () => clearTimeout(timer);
  }, [typed]);

  const queryOf = useCallback(
    (afterId: string | null) => {
      const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
      for (const key of Object.keys(filters) as (keyof Filters)[]) {
        if (filters[key] !== '') query.set(key, filters[key]);
      }
      if (afterId !== null) query.set('afterId', afterId);
      return `${API_ATTRIBUTES}?${query.toString()}`;
    },
    [filters],
  );

  const toSignIn = (status: number): boolean => {
    if (status !== 401) return false;
    window.location.assign('/session-ended');
    return true;
  };

  const fetchRows = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    const result = await callApi<AttributePage>('GET', queryOf(null));
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (toSignIn(result.failure.status)) return;
      setLoad('failed');
      return;
    }
    setRows(result.body.items);
    setPage(result.body);
    setLoad('ready');
  }, [queryOf]);

  useEffect(() => {
    void fetchRows();
  }, [fetchRows]);

  async function loadMore() {
    if (page?.nextAfterId === null || page === null || more) return;
    setMore(true);
    const result = await callApi<AttributePage>('GET', queryOf(page.nextAfterId));
    setMore(false);
    if (!result.ok) {
      if (toSignIn(result.failure.status)) return;
      toast.error(t('more-error'));
      return;
    }
    setRows((previous) => [...previous, ...result.body.items]);
    setPage(result.body);
  }

  const locales: MarketLocales | null = page?.locales ?? null;
  const filtered = Object.values(filters).some((value) => value !== '');
  const set = (key: keyof Filters) => (value: string) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const featureSetOptions: readonly SearchSelectOption[] = (page?.featureSets ?? []).map(
    (featureSet) => ({ value: featureSet.id, label: featureSet.code }),
  );
  const otherLocales = locales?.supported.filter((locale) => locale !== locales.default) ?? [];

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section
        aria-label={t('list-label')}
        className="flex min-w-0 flex-col rounded-lg border border-line bg-surface"
      >
        {canEdit && locales !== null ? (
          <div className="flex justify-end border-b border-line px-4 py-3">
            <Button onClick={() => setAdding(true)}>{t('add.open')}</Button>
          </div>
        ) : null}
        <div
          role="search"
          aria-label={t('filters')}
          className="grid gap-3 border-b border-line p-4 sm:grid-cols-2"
        >
          <div className="sm:col-span-2">
            <TextField
              name="search"
              type="search"
              label={t('search')}
              value={typed}
              autoComplete="off"
              onChange={(event) => setTyped(event.target.value)}
            />
          </div>
          <Pick
            label={t('filter.type')}
            placeholder={t('filter.all')}
            clearLabel={t('filter.clear')}
            options={DATA_TYPES.map((type) => ({ value: type, label: t(`type.${type}`) }))}
            value={filters.type}
            onChange={set('type')}
          />
          <Pick
            label={t('filter.status')}
            placeholder={t('filter.all')}
            clearLabel={t('filter.clear')}
            options={STATUSES.map((status) => ({ value: status, label: t(`status.${status}`) }))}
            value={filters.status}
            onChange={set('status')}
          />
          <Pick
            label={t('filter.used-in')}
            placeholder={t('filter.all-feature-sets')}
            clearLabel={t('filter.clear-feature-set')}
            options={featureSetOptions}
            value={filters.usedIn}
            onChange={set('usedIn')}
          />
          {otherLocales.length > 0 && locales !== null ? (
            <Pick
              label={t('filter.missing')}
              placeholder={t('filter.any-language')}
              clearLabel={t('filter.clear')}
              options={otherLocales.map((locale) => ({
                value: locale,
                label: t('filter.missing-in', {
                  language: languageName(locale, locales.supported),
                }),
              }))}
              value={filters.missing}
              onChange={set('missing')}
            />
          ) : null}
        </div>
        {load === 'loading' ? (
          <div className="p-4">
            <SkeletonRows label={t('loading')} rows={5} />
          </div>
        ) : null}
        {load === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3 p-6"
            message={t('load-error')}
            retryLabel={tl('retry')}
            onRetry={() => void fetchRows()}
          />
        ) : null}
        {load === 'ready' && rows.length === 0 ? (
          <EmptyState
            size="compact"
            icon="sliders"
            title={filtered ? t('empty-filtered') : t('empty')}
            action={
              filtered ? (
                <Button
                  variant="secondary"
                  onClick={() => {
                    setTyped('');
                    setFilters(NO_FILTERS);
                  }}
                >
                  {t('clear-filters')}
                </Button>
              ) : undefined
            }
          />
        ) : null}
        {load === 'ready' && rows.length > 0 && locales !== null ? (
          <ul className="divide-y divide-line" aria-label={t('list-label')}>
            {rows.map((row) => (
              <AttributeLine
                key={row.id}
                row={row}
                locales={locales}
                selected={row.id === selectedId}
                onOpen={() => onSelect(row.id)}
              />
            ))}
          </ul>
        ) : null}
        {load === 'ready' && page !== null ? (
          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3 text-sm text-fg-muted">
            <p>
              {filtered
                ? t('footer.filtered', { count: page.total, all: page.totalAll })
                : t('footer.all', { count: page.totalAll })}
              {page.truncated ? ` ${t('footer.truncated')}` : ''}
            </p>
            {page.nextAfterId !== null ? (
              <Button
                variant="secondary"
                loading={more}
                disabled={more}
                onClick={() => void loadMore()}
              >
                {t('more')}
              </Button>
            ) : null}
          </div>
        ) : null}
      </section>
      <AttributeDetailPanel
        attributeId={selectedId}
        onClose={() => onSelect(null)}
        canEdit={canEdit}
        canRestructure={canRestructure}
        csrfToken={csrfToken}
        onChanged={() => void fetchRows()}
        onOpenWaiting={onOpenWaiting}
      />
      {adding && locales !== null ? (
        <AddAttributeDialog
          locales={locales}
          units={page?.units ?? []}
          csrfToken={csrfToken}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            toast.success(t('add.created'));
            void fetchRows();
            onSelect(id);
          }}
        />
      ) : null}
    </div>
  );
}

function AttributeLine({
  row,
  locales,
  selected,
  onOpen,
}: {
  readonly row: AttributeRow;
  readonly locales: MarketLocales;
  readonly selected: boolean;
  readonly onOpen: () => void;
}) {
  const t = useTranslations('attributes');
  const name = textIn(row.names, locales.default, locales.default, row.code);
  const missing = row.missingLocales.map((locale) => languageName(locale, locales.supported));
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onOpen}
        className={[
          'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 text-start',
          'hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
          selected ? 'bg-muted' : '',
        ].join(' ')}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="font-semibold wrap-anywhere text-fg">{name}</span>
          {row.material ? <Badge tone="attention">{t('badge.material')}</Badge> : null}
          {row.isVariantOption ? <Badge tone="info">{t('badge.variant')}</Badge> : null}
          {row.status !== 'active' ? (
            <Badge tone="neutral">{t(`status.${row.status}`)}</Badge>
          ) : null}
        </span>
        <span className="text-sm whitespace-nowrap text-fg-muted">
          {t('row.products', { count: row.productCount })}
        </span>
        <span className="col-span-2 text-sm wrap-anywhere text-fg-muted">
          {row.code} · {t(`type.${row.dataType}`)} ·{' '}
          {t('row.feature-sets', { count: row.featureSetCount })}
        </span>
        <span className="col-span-2 flex flex-wrap gap-2 text-sm">
          {missing.length === 0 ? (
            <span className="text-fg-muted">{t('row.all-languages')}</span>
          ) : (
            missing.map((language) => (
              <Badge key={language} tone="attention">
                {t('row.missing', { languages: language })}
              </Badge>
            ))
          )}
        </span>
      </button>
    </li>
  );
}

/** One filter: the searchable dropdown (the panel's one dropdown for filters, same height). */
function Pick({
  label,
  placeholder,
  clearLabel,
  options,
  value,
  onChange,
}: {
  readonly label: string;
  readonly placeholder: string;
  readonly clearLabel: string;
  readonly options: readonly SearchSelectOption[];
  readonly value: string;
  readonly onChange: (value: string) => void;
}) {
  const selectLabels = useSelectLabels();
  return (
    <SearchSelect
      label={label}
      placeholder={placeholder}
      options={options}
      value={options.find((option) => option.value === value) ?? null}
      labels={selectLabels}
      clearLabel={clearLabel}
      onChange={(option) => onChange(option?.value ?? '')}
    />
  );
}
