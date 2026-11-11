'use client';

import {
  Badge,
  Banner,
  Button,
  IconButton,
  LoadError,
  RadioGroup,
  Select,
  SkeletonRows,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { directionOf } from './tree-model.ts';
import {
  API_ATTRIBUTES,
  API_FEATURE_SETS,
  LINKS_SUFFIX,
  MAX_OWN_FILTERS,
  draftOf,
  filterChoices,
  labelOf,
  linksErrorKey,
  moveFilter,
  sameDraft,
  type AttributeOption,
  type FeatureSetOption,
  type LinksBody,
  type LinksDraft,
} from './attribute-links-model.ts';
import { API_CATEGORIES, type DetailBody } from './types.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly links: LinksBody }
  | { readonly state: 'failed' };

interface Pickers {
  readonly featureSets: readonly FeatureSetOption[];
  readonly attributes: readonly AttributeOption[];
}

/** The most pages of attributes the editor reads (50 each): a Market has far fewer. */
const ATTRIBUTE_PAGES = 20;

/**
 * The "Attribute links" tab of a category (categories C8, inside attributes A4): the feature set
 * the category holds, or "Inherited from {parent}", and the ordered list of attributes buyers may
 * filter it by. Children inherit both; a feature set on a child overrides. Reading needs
 * `catalog.attribute.view`, changing it `catalog.attribute.edit`.
 */
export function AttributeLinksTab({
  body,
  canEdit,
  csrfToken,
}: {
  readonly body: DetailBody;
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('categories.links');
  const tl = useTranslations('load');
  const categoryId = body.category.id;
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState(false);
  const latest = useRef(0);

  const fetchLinks = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad({ state: 'loading' });
    const result = await callApi<LinksBody>(
      'GET',
      `${API_CATEGORIES}/${categoryId}/${LINKS_SUFFIX}`,
    );
    if (ticket !== latest.current) return;
    if (result.ok) {
      setLoad({ state: 'ready', links: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: 'failed' });
  }, [categoryId]);

  useEffect(() => {
    void fetchLinks();
  }, [fetchLinks]);

  if (load.state === 'loading') return <SkeletonRows label={t('loading')} rows={3} />;
  if (load.state === 'failed') {
    return (
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('load-error')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchLinks()}
      />
    );
  }
  const locale = body.requiredLocales[0] ?? '';
  if (editing) {
    return (
      <LinksEditor
        body={body}
        links={load.links}
        locale={locale}
        csrfToken={csrfToken}
        onCancel={() => setEditing(false)}
        onReload={() => {
          setEditing(false);
          void fetchLinks();
        }}
        onSaved={() => {
          setEditing(false);
          setSaved(true);
          void fetchLinks();
        }}
      />
    );
  }
  return (
    <LinksView
      body={body}
      links={load.links}
      locale={locale}
      canEdit={canEdit}
      saved={saved}
      onEdit={() => {
        setSaved(false);
        setEditing(true);
      }}
    />
  );
}

/** Where an inherited value comes from: the ancestor's name, or a plain word when not on the path. */
function parentName(body: DetailBody, fromCategoryId: string): string | null {
  const entry = body.path.find((step) => step.id === fromCategoryId);
  return entry === undefined ? null : (entry.name ?? entry.slug);
}

function LinksView({
  body,
  links,
  locale,
  canEdit,
  saved,
  onEdit,
}: {
  readonly body: DetailBody;
  readonly links: LinksBody;
  readonly locale: string;
  readonly canEdit: boolean;
  readonly saved: boolean;
  readonly onEdit: () => void;
}) {
  const t = useTranslations('categories.links');
  const { featureSet, filters } = links.effective;
  return (
    <section aria-label={t('label')} className="flex flex-col gap-4">
      {saved ? (
        <p role="status" className="m-0 text-sm text-fg-muted">
          {t('saved')}
        </p>
      ) : null}
      {canEdit ? null : <Banner tone="info">{t('view-only')}</Banner>}
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-semibold">{t('feature-set')}</h3>
        {featureSet === null ? (
          <p className="m-0 text-fg-muted">{t('no-feature-set')}</p>
        ) : (
          <p className="m-0 flex flex-wrap items-center gap-2">
            <span dir={directionOf(locale)}>
              {labelOf(featureSet.names, locale, featureSet.code)}
            </span>
            <code className="text-sm text-fg-muted">{featureSet.code}</code>
            {featureSet.inherited ? (
              <Badge tone="neutral">
                {t('inherited-from', {
                  parent: parentName(body, featureSet.fromCategoryId) ?? t('a-parent'),
                })}
              </Badge>
            ) : (
              <Badge tone="success">{t('own')}</Badge>
            )}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-semibold">{t('filters')}</h3>
        {filters.length === 0 ? (
          <p className="m-0 text-fg-muted">{t('no-filters')}</p>
        ) : (
          <ol
            aria-label={t('filters')}
            className="m-0 flex list-none flex-col divide-y divide-line rounded-lg border border-line bg-surface p-0"
          >
            {filters.map((filter, index) => (
              <li key={filter.code} className="flex flex-wrap items-center gap-2 px-4 py-2">
                <span className="w-6 text-sm text-fg-muted">{index + 1}</span>
                <span dir={directionOf(locale)}>{labelOf(filter.names, locale, filter.code)}</span>
                <code className="text-sm text-fg-muted">{filter.code}</code>
                {filter.dataType === null ? null : (
                  <span className="text-sm text-fg-muted">{t(`type.${filter.dataType}`)}</span>
                )}
                {filter.status === null || filter.status === 'active' ? null : (
                  <Badge tone="attention">{t('not-active')}</Badge>
                )}
                {filter.inherited ? (
                  <Badge tone="neutral">
                    {t('inherited-from', {
                      parent: parentName(body, filter.fromCategoryId) ?? t('a-parent'),
                    })}
                  </Badge>
                ) : null}
              </li>
            ))}
          </ol>
        )}
        <p className="m-0 text-sm text-fg-muted">{t('noindex-help')}</p>
      </div>
      {canEdit ? (
        <div>
          <Button variant="secondary" onClick={onEdit}>
            {t('edit')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function LinksEditor({
  body,
  links,
  locale,
  csrfToken,
  onCancel,
  onReload,
  onSaved,
}: {
  readonly body: DetailBody;
  readonly links: LinksBody;
  readonly locale: string;
  readonly csrfToken: string;
  readonly onCancel: () => void;
  readonly onReload: () => void;
  readonly onSaved: () => void;
}) {
  const t = useTranslations('categories.links');
  const tl = useTranslations('load');
  const start = useRef(draftOf(links)).current;
  const [draft, setDraft] = useState<LinksDraft>(start);
  const [picker, setPicker] = useState('');
  const [pickers, setPickers] = useState<Pickers | 'loading' | 'failed'>('loading');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const busy = useRef(false);

  const fetchPickers = useCallback(async () => {
    setPickers('loading');
    const sets = await callApi<{ readonly items: readonly FeatureSetOption[] }>(
      'GET',
      API_FEATURE_SETS,
    );
    if (!sets.ok) {
      if (sets.failure.status === 401) window.location.assign('/session-ended');
      setPickers('failed');
      return;
    }
    const attributes: AttributeOption[] = [];
    let after: string | null = null;
    for (let page = 0; page < ATTRIBUTE_PAGES; page += 1) {
      const query = new URLSearchParams({ status: 'active', limit: '50' });
      if (after !== null) query.set('afterId', after);
      const answer = await callApi<{
        readonly items: readonly (AttributeOption & { readonly id: string })[];
        readonly nextAfterId: string | null;
      }>('GET', `${API_ATTRIBUTES}?${query.toString()}`);
      if (!answer.ok) {
        if (answer.failure.status === 401) window.location.assign('/session-ended');
        setPickers('failed');
        return;
      }
      attributes.push(...answer.body.items);
      after = answer.body.nextAfterId;
      if (after === null) break;
    }
    setPickers({ featureSets: sets.body.items.filter((s) => s.status === 'active'), attributes });
  }, []);

  useEffect(() => {
    void fetchPickers();
  }, [fetchPickers]);

  const changed = !sameDraft(draft, start);
  const inheritedCodes = links.effective.filters
    .filter((filter) => filter.inherited)
    .map((filter) => filter.code);
  const taken = new Set([...inheritedCodes, ...draft.filters]);
  const known = pickers === 'loading' || pickers === 'failed' ? [] : pickers.attributes;
  const nameOfCode = (code: string): string => {
    const found =
      known.find((attribute) => attribute.code === code)?.names ??
      links.effective.filters.find((filter) => filter.code === code)?.names ??
      null;
    return labelOf(found, locale, code);
  };
  const parent = body.path.length >= 2 ? body.path[body.path.length - 2] : undefined;
  const parentLabel = parent === undefined ? t('a-parent') : (parent.name ?? parent.slug);
  const inheritedSet =
    links.effective.featureSet?.inherited === true ? links.effective.featureSet : null;

  async function save() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<unknown>(
      'PUT',
      `${API_CATEGORIES}/${body.category.id}/${LINKS_SUFFIX}`,
      {
        featureSetId: draft.featureSetId,
        filters: draft.filters,
        ...(links.own === null ? {} : { version: links.own.version }),
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
    setProblem(linksErrorKey(result.failure.status, result.failure.code));
  }

  if (pickers === 'loading') return <SkeletonRows label={t('loading')} rows={3} />;
  if (pickers === 'failed') {
    return (
      <LoadError
        className="flex flex-col items-start gap-3"
        message={t('load-error')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchPickers()}
      />
    );
  }
  const choices = filterChoices(pickers.attributes, taken);
  const ownSet = draft.featureSetId !== null;
  return (
    <section aria-label={t('edit-label')} className="flex flex-col gap-5">
      <Banner tone="info">{t('impact')}</Banner>
      {problem === null ? null : (
        <Banner tone="critical">
          {t(`error.${problem}`)}
          {problem === 'stale' ? (
            <>
              {' '}
              <Button variant="secondary" onClick={onReload}>
                {t('reload')}
              </Button>
            </>
          ) : null}
        </Banner>
      )}
      <RadioGroup
        legend={t('feature-set')}
        name="feature-set-source"
        value={ownSet ? 'own' : 'inherit'}
        disabled={pending}
        options={[
          {
            value: 'inherit',
            label:
              inheritedSet === null && links.own?.featureSetId == null
                ? t('inherit-none', { parent: parentLabel })
                : t('inherit', { parent: parentLabel }),
          },
          { value: 'own', label: t('use-own') },
        ]}
        onChange={(value) =>
          setDraft({
            ...draft,
            featureSetId: value === 'inherit' ? null : (pickers.featureSets[0]?.id ?? null),
          })
        }
      />
      {ownSet ? (
        <Select
          label={t('feature-set-pick')}
          value={draft.featureSetId ?? ''}
          disabled={pending}
          options={pickers.featureSets.map((set) => ({
            value: set.id,
            label: `${labelOf(set.names, locale, set.code)} (${set.code})`,
          }))}
          onChange={(event) => setDraft({ ...draft, featureSetId: event.target.value })}
        />
      ) : null}
      <div className="flex flex-col gap-2">
        <h3 className="m-0 text-base font-semibold">{t('filters')}</h3>
        {inheritedCodes.length > 0 ? (
          <p className="m-0 text-sm text-fg-muted">
            {t('inherited-filters', { parent: parentLabel, count: inheritedCodes.length })}
          </p>
        ) : null}
        {draft.filters.length === 0 ? (
          <p className="m-0 text-fg-muted">{t('no-own-filters')}</p>
        ) : (
          <ol
            aria-label={t('own-filters')}
            className="m-0 flex list-none flex-col divide-y divide-line rounded-lg border border-line bg-surface p-0"
          >
            {draft.filters.map((code, index) => (
              <li key={code} className="flex flex-wrap items-center gap-2 px-4 py-1">
                <span className="w-6 text-sm text-fg-muted">
                  {inheritedCodes.length + index + 1}
                </span>
                <span className="min-w-0 flex-1 wrap-anywhere" dir={directionOf(locale)}>
                  {nameOfCode(code)}
                  <code className="ms-2 text-sm text-fg-muted">{code}</code>
                </span>
                <IconButton
                  icon="chevron-up"
                  label={t('move-up', { name: nameOfCode(code) })}
                  disabled={pending || index === 0}
                  onClick={() =>
                    setDraft({ ...draft, filters: moveFilter(draft.filters, index, -1) })
                  }
                />
                <IconButton
                  icon="chevron-down"
                  label={t('move-down', { name: nameOfCode(code) })}
                  disabled={pending || index === draft.filters.length - 1}
                  onClick={() =>
                    setDraft({ ...draft, filters: moveFilter(draft.filters, index, 1) })
                  }
                />
                <IconButton
                  icon="x"
                  label={t('remove', { name: nameOfCode(code) })}
                  disabled={pending}
                  onClick={() =>
                    setDraft({ ...draft, filters: draft.filters.filter((entry) => entry !== code) })
                  }
                />
              </li>
            ))}
          </ol>
        )}
        {draft.filters.length >= MAX_OWN_FILTERS ? (
          <p className="m-0 text-sm text-fg-muted">{t('error.too-many')}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-2">
            <Select
              label={t('add-filter')}
              placeholder={choices.length === 0 ? t('no-choices') : t('pick-filter')}
              value={picker}
              disabled={pending || choices.length === 0}
              options={choices.map((attribute) => ({
                value: attribute.code,
                label: `${labelOf(attribute.names, locale, attribute.code)} (${t(`type.${attribute.dataType}`)})`,
              }))}
              onChange={(event) => {
                const code = event.target.value;
                if (code === '') return;
                setDraft({ ...draft, filters: [...draft.filters, code] });
                setPicker('');
              }}
            />
          </div>
        )}
        <p className="m-0 text-sm text-fg-muted">{t('noindex-help')}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button loading={pending} disabled={!changed || pending} onClick={() => void save()}>
          {t('save')}
        </Button>
      </div>
    </section>
  );
}
