'use client';

import { Badge, Button, EmptyState, LoadError, SkeletonRows, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { When } from '../shared/when.tsx';
import { API_FEATURE_SETS, textIn, type FeatureSetDetail, type FeatureSetList } from './types.ts';
import { useRevealWhenStacked } from './reveal.ts';

type Load<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'missing' }
  | { readonly state: 'failed' };

const ROW =
  'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 text-start hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/**
 * The Feature sets tab: every feature set (attribute family) of the Market, by code, with its
 * counts; beside it the chosen set's groups and attributes. An attribute opens on the
 * Attributes tab.
 */
export function FeatureSetsTab({
  selectedId,
  onSelect,
  onOpenAttribute,
}: {
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly onOpenAttribute: (attributeId: string) => void;
}) {
  const t = useTranslations('attributes.feature-sets');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load<FeatureSetList>>({ state: 'loading' });
  const [search, setSearch] = useState('');

  const fetchSets = useCallback(async () => {
    setLoad({ state: 'loading' });
    const result = await callApi<FeatureSetList>('GET', API_FEATURE_SETS);
    if (result.ok) {
      setLoad({ state: 'ready', value: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: 'failed' });
  }, []);

  useEffect(() => {
    void fetchSets();
  }, [fetchSets]);

  const needle = search.trim().toLowerCase();
  const rows =
    load.state === 'ready'
      ? load.value.items.filter((row) => needle === '' || row.code.toLowerCase().includes(needle))
      : [];

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <section
        aria-label={t('list-label')}
        className="flex min-w-0 flex-col rounded-lg border border-line bg-surface"
      >
        <div role="search" aria-label={t('filters')} className="border-b border-line p-4">
          <TextField
            name="feature-set-search"
            type="search"
            label={t('search')}
            value={search}
            autoComplete="off"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        {load.state === 'loading' ? (
          <div className="p-4">
            <SkeletonRows label={t('loading')} rows={4} />
          </div>
        ) : null}
        {load.state === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3 p-6"
            message={t('load-error')}
            retryLabel={tl('retry')}
            onRetry={() => void fetchSets()}
          />
        ) : null}
        {load.state === 'ready' && rows.length === 0 ? (
          <EmptyState
            size="compact"
            icon="columns"
            title={load.value.items.length === 0 ? t('empty') : t('empty-filtered')}
            action={
              load.value.items.length === 0 ? undefined : (
                <Button variant="secondary" onClick={() => setSearch('')}>
                  {t('clear-search')}
                </Button>
              )
            }
          />
        ) : null}
        {rows.length > 0 ? (
          <ul className="divide-y divide-line" aria-label={t('list-label')}>
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  aria-current={row.id === selectedId ? 'true' : undefined}
                  onClick={() => onSelect(row.id)}
                  className={`${ROW} ${row.id === selectedId ? 'bg-muted' : ''}`}
                >
                  <span className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="font-semibold wrap-anywhere text-fg">{row.code}</span>
                    {row.status !== 'active' ? (
                      <Badge tone="neutral">{t(`status.${row.status}`)}</Badge>
                    ) : null}
                  </span>
                  <span className="text-sm whitespace-nowrap text-fg-muted">
                    {t('products', { count: row.productCount })}
                  </span>
                  <span className="col-span-2 text-sm text-fg-muted">
                    {t('counts', { groups: row.groupCount, attributes: row.attributeCount })}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {load.state === 'ready' && load.value.truncated ? (
          <p className="border-t border-line px-4 py-3 text-sm text-fg-muted">{t('truncated')}</p>
        ) : null}
      </section>
      <FeatureSetDetailPanel
        featureSetId={selectedId}
        onClose={() => onSelect(null)}
        onOpenAttribute={onOpenAttribute}
      />
    </div>
  );
}

function FeatureSetDetailPanel({
  featureSetId,
  onClose,
  onOpenAttribute,
}: {
  readonly featureSetId: string | null;
  readonly onClose: () => void;
  readonly onOpenAttribute: (attributeId: string) => void;
}) {
  const t = useTranslations('attributes');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load<FeatureSetDetail>>({ state: 'loading' });
  const latest = useRef(0);
  const panel = useRef<HTMLElement>(null);
  useRevealWhenStacked(panel, featureSetId, load.state === 'ready');

  const fetchSet = useCallback(async () => {
    if (featureSetId === null) return;
    const ticket = ++latest.current;
    setLoad({ state: 'loading' });
    const result = await callApi<FeatureSetDetail>(
      'GET',
      `${API_FEATURE_SETS}/${encodeURIComponent(featureSetId)}`,
    );
    if (ticket !== latest.current) return;
    if (result.ok) {
      setLoad({ state: 'ready', value: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: result.failure.status === 404 ? 'missing' : 'failed' });
  }, [featureSetId]);

  useEffect(() => {
    void fetchSet();
  }, [fetchSet]);

  if (featureSetId === null) {
    return (
      <EmptyState
        size="card"
        icon="columns"
        title={t('feature-sets.none')}
        body={t('feature-sets.none-body')}
      />
    );
  }

  return (
    <section
      ref={panel}
      aria-label={t('feature-sets.detail-label')}
      aria-busy={load.state === 'loading'}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-5"
    >
      {load.state === 'loading' ? (
        <SkeletonRows label={t('feature-sets.loading-one')} rows={5} />
      ) : null}
      {load.state === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('feature-sets.load-one-error')}
          retryLabel={tl('retry')}
          onRetry={() => void fetchSet()}
        />
      ) : null}
      {load.state === 'missing' ? (
        <div className="flex flex-col items-start gap-3">
          <p className="text-fg-muted">{t('feature-sets.missing')}</p>
          <Button variant="secondary" onClick={onClose}>
            {t('detail.close')}
          </Button>
        </div>
      ) : null}
      {load.state === 'ready' ? (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="flex min-w-0 flex-col gap-1">
              <div className="flex flex-wrap items-center gap-2">
                <h2 tabIndex={-1} className="text-lg font-semibold wrap-anywhere text-fg">
                  {load.value.code}
                </h2>
                <Badge tone={load.value.status === 'active' ? 'success' : 'neutral'}>
                  {t(`feature-sets.status.${load.value.status}`)}
                </Badge>
              </div>
              <p className="text-sm text-fg-muted">
                {t('feature-sets.revision-products', {
                  number: load.value.revisionNo,
                  count: load.value.productCount,
                })}
              </p>
              <span className="text-sm text-fg-muted">
                <When iso={load.value.createdAt} missing={t('none')} />
              </span>
            </div>
            <Button variant="secondary" onClick={onClose}>
              {t('detail.close')}
            </Button>
          </div>
          {load.value.groups.length === 0 ? (
            <EmptyState size="compact" icon="columns" title={t('feature-sets.no-groups')} />
          ) : (
            load.value.groups.map((group) => (
              <section
                key={group.groupCode}
                aria-label={t('feature-sets.group', { group: group.groupCode })}
                className="flex flex-col gap-2"
              >
                <h3 className="font-semibold text-fg">
                  {t('feature-sets.group', { group: group.groupCode })}
                </h3>
                <ul className="divide-y divide-line rounded-md border border-line">
                  {group.attributes.map((entry) => {
                    const { locales } = load.value;
                    const name = textIn(entry.names, locales.default, locales.default, entry.code);
                    return (
                      <li
                        key={entry.code}
                        className="flex flex-wrap items-center justify-between gap-2 px-4 py-3"
                      >
                        <span className="flex min-w-0 flex-col">
                          {entry.attributeId === null ? (
                            <span className="font-medium wrap-anywhere text-fg">{name}</span>
                          ) : (
                            <button
                              type="button"
                              className="min-h-12 text-start font-medium wrap-anywhere text-link underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-focus"
                              onClick={() => onOpenAttribute(entry.attributeId as string)}
                            >
                              {name}
                            </button>
                          )}
                          <span className="text-sm wrap-anywhere text-fg-muted">
                            {entry.dataType === null
                              ? t('feature-sets.unknown', { code: entry.code })
                              : `${entry.code} · ${t(`type.${entry.dataType}`)}`}
                          </span>
                        </span>
                        <span className="flex flex-wrap gap-2">
                          <Badge tone={entry.required ? 'info' : 'neutral'}>
                            {entry.required ? t('used-in.required') : t('used-in.optional')}
                          </Badge>
                          {entry.isVariantOption ? (
                            <Badge tone="info">{t('badge.variant')}</Badge>
                          ) : null}
                          {entry.material === true ? (
                            <Badge tone="attention">{t('badge.material')}</Badge>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))
          )}
        </>
      ) : null}
    </section>
  );
}
