'use client';

import {
  Badge,
  Banner,
  Button,
  CheckboxRow,
  EmptyState,
  LoadError,
  Select,
  SkeletonRows,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { loadActiveAttributes } from '../attributes/load-active-attributes.ts';
import {
  API_FEATURE_SETS,
  type AttributePage,
  type FeatureSetList,
  type Localized,
} from '../attributes/types.ts';

/** What the category links API answers (catalog, attributes A3: category-attribute-links). */
export interface LinksBody {
  readonly own: {
    readonly featureSetId: string | null;
    readonly filters: readonly string[];
    readonly version: number;
  } | null;
  readonly effective: {
    readonly featureSet: {
      readonly id: string;
      readonly code: string;
      readonly fromCategoryId: string;
      readonly inherited: boolean;
    } | null;
    readonly filters: readonly {
      readonly code: string;
      readonly inherited: boolean;
      readonly names: Localized | null;
      readonly dataType: string | null;
    }[];
  };
}

/** The data types a page filter can use (design decision ت۸). */
export const FILTERABLE = ['select', 'multi-select', 'integer', 'decimal', 'boolean'] as const;

/** The message key of a refused save. */
export function linksErrorKey(code: string, status: number): string {
  if (code === 'category-links.stale') return 'stale';
  if (code === 'category.not-active') return 'not-active';
  if (code === 'category-links.too-many-filters') return 'too-many-filters';
  if (code.startsWith('category-links.feature-set')) return 'feature-set';
  if (code.startsWith('category-links.filter')) return 'filter';
  if (code === 'validation.failed') return 'invalid';
  return status === 0 || status >= 500 ? 'unavailable' : 'unknown';
}

/** The name in the preferred language, else in any language, else the code. */
export function nameOf(names: Localized | null | undefined, code: string, preferred = ''): string {
  if (!names) return code;
  return names[preferred] ?? Object.values(names)[0] ?? code;
}

/** Moves a list entry one place; unchanged when it falls outside. */
export function shifted<T>(list: readonly T[], index: number, by: -1 | 1): readonly T[] {
  const target = index + by;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) return list;
  const next = [...list];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item as T);
  return next;
}

type Load = 'loading' | 'ready' | 'failed' | 'gone';

/**
 * The "Attribute links" tab of a category (attributes A4, screens 03 and 04): the feature set the
 * category uses (its own, or its parent's) and the attributes that filter its page.
 */
export function AttributeLinksTab({
  categoryId,
  canEdit,
  csrfToken,
}: {
  readonly categoryId: string;
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('categories.links');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>('loading');
  const [body, setBody] = useState<LinksBody | null>(null);
  const [editing, setEditing] = useState(false);

  const fetchLinks = useCallback(async () => {
    setLoad('loading');
    const result = await callApi<LinksBody>(
      'GET',
      `catalog/admin/categories/${categoryId}/attribute-links`,
    );
    if (result.ok) {
      setBody(result.body);
      setLoad('ready');
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad(result.failure.status === 404 ? 'gone' : 'failed');
  }, [categoryId]);

  useEffect(() => {
    void fetchLinks();
  }, [fetchLinks]);

  if (load === 'loading') return <SkeletonRows label={t('loading')} rows={4} />;
  if (load === 'gone') return <p className="text-fg-muted">{t('gone')}</p>;
  if (load === 'failed' || body === null) {
    return (
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('load-error')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchLinks()}
      />
    );
  }
  if (editing) {
    return (
      <LinksEditor
        categoryId={categoryId}
        body={body}
        csrfToken={csrfToken}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          void fetchLinks();
        }}
      />
    );
  }
  const set = body.effective.featureSet;
  return (
    <div className="flex flex-col gap-5">
      <section aria-label={t('feature-set')} className="flex flex-col gap-2">
        <h3 className="font-semibold text-fg">{t('feature-set')}</h3>
        {set === null ? (
          <EmptyState size="compact" icon="columns" title={t('no-feature-set')} />
        ) : (
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-medium wrap-anywhere text-fg">{set.code}</span>
            <Badge tone="neutral">{set.inherited ? t('inherited') : t('own')}</Badge>
          </p>
        )}
      </section>
      <section aria-label={t('filters')} className="flex flex-col gap-2">
        <h3 className="font-semibold text-fg">{t('filters')}</h3>
        {body.effective.filters.length === 0 ? (
          <p className="text-fg-muted">{t('no-filters')}</p>
        ) : (
          <ol className="divide-y divide-line rounded-md border border-line">
            {body.effective.filters.map((filter, index) => (
              <li key={filter.code} className="flex flex-wrap items-center gap-2 px-4 py-3">
                <span className="text-fg-muted">{index + 1}.</span>
                <span className="font-medium wrap-anywhere text-fg">
                  {nameOf(filter.names, filter.code)}
                </span>
                <span className="text-sm text-fg-muted">{filter.code}</span>
                {filter.inherited ? <Badge tone="neutral">{t('inherited')}</Badge> : null}
              </li>
            ))}
          </ol>
        )}
        <p className="text-sm text-fg-muted">{t('noindex')}</p>
      </section>
      {canEdit ? (
        <div>
          <Button onClick={() => setEditing(true)}>{t('edit')}</Button>
        </div>
      ) : null}
    </div>
  );
}

function LinksEditor({
  categoryId,
  body,
  csrfToken,
  onCancel,
  onSaved,
}: {
  readonly categoryId: string;
  readonly body: LinksBody;
  readonly csrfToken: string;
  readonly onCancel: () => void;
  readonly onSaved: () => void;
}) {
  const t = useTranslations('categories.links');
  const [own, setOwn] = useState(body.own?.featureSetId != null);
  const [featureSetId, setFeatureSetId] = useState(body.own?.featureSetId ?? '');
  const [inheritFilters, setInheritFilters] = useState((body.own?.filters.length ?? 0) === 0);
  const [filters, setFilters] = useState<readonly string[]>(body.own?.filters ?? []);
  const [pick, setPick] = useState('');
  const [sets, setSets] = useState<FeatureSetList['items']>([]);
  const [attributes, setAttributes] = useState<AttributePage['items']>([]);
  const [defaultLocale, setDefaultLocale] = useState('');
  const [listFailed, setListFailed] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const busy = useRef(false);

  useEffect(() => {
    let live = true;
    void callApi<FeatureSetList>('GET', API_FEATURE_SETS).then((r) => {
      if (live && r.ok) setSets(r.body.items.filter((row) => row.status === 'active'));
    });
    void loadActiveAttributes().then((result) => {
      if (!live) return;
      if (result.ok) {
        setAttributes(result.items);
        setDefaultLocale(result.locale);
      } else setListFailed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const byCode = new Map(attributes.map((item) => [item.code, item]));
  const addable = attributes.filter(
    (item) =>
      (FILTERABLE as readonly string[]).includes(item.dataType) && !filters.includes(item.code),
  );
  const sent = inheritFilters ? [] : filters;
  const tightens = (own ? featureSetId : '') !== (body.own?.featureSetId ?? '');

  async function save() {
    if (busy.current) return;
    if (own && featureSetId === '') {
      setFailure('need-feature-set');
      return;
    }
    busy.current = true;
    setPending(true);
    setFailure(null);
    const result = await callApi<unknown>(
      'PUT',
      `catalog/admin/categories/${categoryId}/attribute-links`,
      {
        ...(body.own === null ? {} : { version: body.own.version }),
        featureSetId: own ? featureSetId : null,
        filters: sent,
      },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      onSaved();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setFailure(linksErrorKey(result.failure.code, result.failure.status));
  }

  return (
    <section aria-label={t('editor')} className="flex flex-col gap-4">
      {failure === null ? null : <Banner tone="critical">{t(`error.${failure}`)}</Banner>}
      {listFailed ? <Banner tone="critical">{t('error.attributes-unavailable')}</Banner> : null}
      <fieldset className="flex flex-col gap-2">
        <legend className="font-semibold text-fg">{t('feature-set')}</legend>
        <label className="flex items-center gap-2">
          <input type="radio" name="fs-mode" checked={!own} onChange={() => setOwn(false)} />
          {t('inherit')}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name="fs-mode" checked={own} onChange={() => setOwn(true)} />
          {t('use-own')}
        </label>
        {own ? (
          <Select
            label={t('feature-set-select')}
            placeholder={t('choose')}
            value={featureSetId}
            onChange={(event) => setFeatureSetId(event.target.value)}
            options={sets.map((row) => ({ value: row.id, label: row.code }))}
          />
        ) : null}
      </fieldset>
      {tightens ? (
        <Banner tone="info" title={t('impact.title')}>
          {t('impact.body')}
        </Banner>
      ) : null}
      <section aria-label={t('filters')} className="flex flex-col gap-2">
        <h3 className="font-semibold text-fg">{t('filters')}</h3>
        <CheckboxRow
          label={t('inherit-filters')}
          checked={inheritFilters}
          onChange={(event) => setInheritFilters(event.target.checked)}
        />
        {inheritFilters ? null : (
          <>
            <ol className="divide-y divide-line rounded-md border border-line">
              {filters.map((code, index) => (
                <li key={code} className="flex flex-wrap items-center gap-2 px-4 py-2">
                  <span className="text-fg-muted">{index + 1}.</span>
                  <span className="flex-1 font-medium wrap-anywhere text-fg">
                    {nameOf(byCode.get(code)?.names, code, defaultLocale)} ({code})
                  </span>
                  <Button
                    variant="secondary"
                    disabled={index === 0}
                    onClick={() => setFilters(shifted(filters, index, -1))}
                  >
                    {t('up', { filter: code })}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={index === filters.length - 1}
                    onClick={() => setFilters(shifted(filters, index, 1))}
                  >
                    {t('down', { filter: code })}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => setFilters(filters.filter((entry) => entry !== code))}
                  >
                    {t('remove', { filter: code })}
                  </Button>
                </li>
              ))}
            </ol>
            <div className="flex flex-wrap items-end gap-2">
              <Select
                label={t('add-filter')}
                placeholder={t('choose')}
                value={pick}
                onChange={(event) => setPick(event.target.value)}
                options={addable.map((item) => ({
                  value: item.code,
                  label: `${nameOf(item.names, item.code, defaultLocale)} (${item.code})`,
                }))}
              />
              <Button
                variant="secondary"
                disabled={pick === ''}
                onClick={() => {
                  setFilters([...filters, pick]);
                  setPick('');
                }}
              >
                {t('add')}
              </Button>
            </div>
          </>
        )}
        <p className="text-sm text-fg-muted">{t('noindex')}</p>
      </section>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button loading={pending} onClick={() => void save()}>
          {t('save')}
        </Button>
      </div>
    </section>
  );
}
