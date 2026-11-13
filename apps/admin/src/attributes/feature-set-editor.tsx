'use client';

import { Badge, Banner, Button, EmptyState, Select, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { loadActiveAttributes } from './load-active-attributes.ts';
import {
  addEntry,
  addGroup,
  codesOf,
  fromDetail,
  isCore,
  isDirty,
  moveEntry,
  moveGroup,
  removeEntry,
  removeGroup,
  removedMaterial,
  renameGroup,
  setLevel,
  tightened,
  toRequest,
  type EditorState,
} from './feature-set-editor-model.ts';
import {
  API_FEATURE_SETS,
  directionOf,
  languageName,
  textIn,
  type AttributePage,
  type FeatureSetDetail,
  type RequirementLevel,
} from './types.ts';

const LEVELS: readonly RequirementLevel[] = ['required', 'recommended', 'optional'];

/** The key under `attributes.feature-sets.editor.error` for a refused save. */
function errorKey(code: string, status: number): string {
  if (code === 'feature-set.stale') return 'stale';
  if (code === 'feature-set.material-removal-needs-request') return 'material-removal';
  if (code === 'validation.failed') return 'invalid';
  if (code.startsWith('feature-set.') || code.startsWith('attribute-definition.')) return 'refused';
  return status === 0 || status >= 500 ? 'unavailable' : 'unknown';
}

function slug(text: string, taken: ReadonlySet<string>): string {
  const base = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  let code = base === '' ? 'group' : base;
  for (let n = 2; taken.has(code); n += 1) code = `${base === '' ? 'group' : base}-${n}`;
  return code;
}

/**
 * The feature set editor (attributes A4, screen 01): the set's names per language, its groups
 * (the core group first and fixed) and the attributes in them, each Required, Recommended or
 * Optional. One save sends the whole set with the version read; the API checks every rule again.
 */
export function FeatureSetEditor({
  detail,
  csrfToken,
  onSaved,
  onCancel,
}: {
  readonly detail: FeatureSetDetail;
  readonly csrfToken: string;
  readonly onSaved: () => void;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('attributes.feature-sets.editor');
  const ta = useTranslations('attributes');
  const [pending, setPending] = useState(false);
  const busy = useRef(false);
  const { locales } = detail;
  const initial = useMemo(() => fromDetail(detail), [detail]);
  const [state, setState] = useState<EditorState>(initial);
  const [locale, setLocale] = useState(locales.default);
  const [failure, setFailure] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<AttributePage['items']>([]);
  const [listFailed, setListFailed] = useState(false);
  const [newGroup, setNewGroup] = useState('');
  const [adding, setAdding] = useState<Readonly<Record<number, string>>>({});

  useEffect(() => {
    let live = true;
    void loadActiveAttributes().then((result) => {
      if (!live) return;
      if (result.ok) setCandidates(result.items);
      else setListFailed(true);
    });
    return () => {
      live = false;
    };
  }, []);

  const dirty = isDirty(initial, state);
  const tight = tightened(initial, state);
  const material = removedMaterial(initial, state);
  const held = codesOf(state);
  const language = languageName(locale, locales.supported);
  const defaultName = state.names[locales.default] ?? '';
  const missingNames = locales.supported.filter((tag) => (state.names[tag] ?? '').trim() === '');

  const nameOf = (code: string, names: Parameters<typeof textIn>[0]) =>
    textIn(names, locales.default, locales.default, code);

  async function save() {
    if (busy.current) return;
    setFailure(null);
    if (defaultName.trim() === '') {
      setFailure('name-required');
      return;
    }
    busy.current = true;
    setPending(true);
    const result = await callApi<unknown>(
      'PUT',
      `${API_FEATURE_SETS}/${encodeURIComponent(detail.id)}`,
      toRequest(state, detail.version ?? 0),
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
    setFailure(errorKey(result.failure.code, result.failure.status));
  }

  return (
    <section
      aria-label={t('label')}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-4 sm:p-5"
    >
      <h2 tabIndex={-1} className="text-lg font-semibold wrap-anywhere text-fg">
        {t('title', { code: detail.code })}
      </h2>
      {failure !== null ? <Banner tone="critical">{t(`error.${failure}`)}</Banner> : null}
      {listFailed ? <Banner tone="critical">{t('error.attributes-unavailable')}</Banner> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Select
          label={t('language')}
          value={locale}
          onChange={(event) => setLocale(event.target.value)}
          options={locales.supported.map((tag) => ({
            value: tag,
            label: languageName(tag, locales.supported),
          }))}
        />
        <div className="flex flex-col gap-1">
          <TextField
            name="feature-set-name"
            label={t('name', { language })}
            lang={locale}
            dir={directionOf(locale)}
            value={state.names[locale] ?? ''}
            onChange={(event) =>
              setState({ ...state, names: { ...state.names, [locale]: event.target.value } })
            }
          />
          {missingNames.length > 0 ? (
            <span>
              <Badge tone="attention">
                {t('missing', {
                  languages: missingNames
                    .map((tag) => languageName(tag, locales.supported))
                    .join(', '),
                })}
              </Badge>
            </span>
          ) : null}
        </div>
      </div>
      {state.groups.length === 0 ? (
        <EmptyState size="compact" icon="columns" title={t('no-groups')} />
      ) : null}
      {state.groups.map((group, g) => {
        const pick = adding[g] ?? '';
        return (
          <section
            key={group.groupCode}
            aria-label={ta('feature-sets.group', { group: group.groupCode })}
            className="flex flex-col gap-2 rounded-md border border-line p-3"
          >
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div className="min-w-0 flex-1">
                <TextField
                  name={`group-${group.groupCode}`}
                  label={t('group-name', { group: group.groupCode, language })}
                  lang={locale}
                  dir={directionOf(locale)}
                  value={group.names[locale] ?? ''}
                  onChange={(event) =>
                    setState(
                      renameGroup(state, g, { ...group.names, [locale]: event.target.value }),
                    )
                  }
                />
              </div>
              {isCore(group) ? (
                <Badge tone="neutral">{t('core')}</Badge>
              ) : (
                <span className="flex gap-2">
                  <Button
                    variant="secondary"
                    disabled={g <= 1}
                    onClick={() => setState(moveGroup(state, g, -1))}
                  >
                    {t('group-up', { group: group.groupCode })}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={g === state.groups.length - 1}
                    onClick={() => setState(moveGroup(state, g, 1))}
                  >
                    {t('group-down', { group: group.groupCode })}
                  </Button>
                  <Button variant="secondary" onClick={() => setState(removeGroup(state, g))}>
                    {t('group-remove', { group: group.groupCode })}
                  </Button>
                </span>
              )}
            </div>
            <ul className="divide-y divide-line rounded-md border border-line">
              {group.entries.map((entry, e) => (
                <li key={entry.code} className="flex flex-wrap items-end gap-2 px-3 py-2">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="font-medium wrap-anywhere text-fg">
                      {nameOf(entry.code, entry.names)}
                    </span>
                    <span className="text-sm text-fg-muted">{entry.code}</span>
                  </span>
                  {entry.isVariantOption ? <Badge tone="info">{ta('badge.variant')}</Badge> : null}
                  {entry.material ? <Badge tone="attention">{ta('badge.material')}</Badge> : null}
                  <Select
                    label={t('level-of', { attribute: entry.code })}
                    value={entry.level}
                    onChange={(event) =>
                      setState(setLevel(state, g, e, event.target.value as RequirementLevel))
                    }
                    options={LEVELS.map((level) => ({ value: level, label: t(`level.${level}`) }))}
                  />
                  <Button
                    variant="secondary"
                    disabled={e === 0}
                    onClick={() => setState(moveEntry(state, g, e, -1))}
                  >
                    {t('entry-up', { attribute: entry.code })}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={e === group.entries.length - 1}
                    onClick={() => setState(moveEntry(state, g, e, 1))}
                  >
                    {t('entry-down', { attribute: entry.code })}
                  </Button>
                  <Button variant="secondary" onClick={() => setState(removeEntry(state, g, e))}>
                    {t('entry-remove', { attribute: entry.code })}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex flex-wrap items-end gap-2">
              <Select
                label={t('add-attribute-to', { group: group.groupCode })}
                placeholder={t('choose')}
                value={pick}
                onChange={(event) => setAdding({ ...adding, [g]: event.target.value })}
                options={candidates
                  .filter((item) => !held.has(item.code))
                  .map((item) => ({
                    value: item.code,
                    label: `${nameOf(item.code, item.names)} (${item.code})`,
                  }))}
              />
              <Button
                variant="secondary"
                disabled={pick === ''}
                onClick={() => {
                  const item = candidates.find((candidate) => candidate.code === pick);
                  if (item === undefined) return;
                  setState(
                    addEntry(state, g, {
                      code: item.code,
                      level: 'optional',
                      names: item.names,
                      dataType: item.dataType,
                      isVariantOption: item.isVariantOption,
                      material: item.material,
                    }),
                  );
                  setAdding({ ...adding, [g]: '' });
                }}
              >
                {t('add-attribute')}
              </Button>
            </div>
          </section>
        );
      })}
      <div className="flex flex-wrap items-end gap-2">
        <TextField
          name="new-group"
          label={t('new-group', { language: languageName(locales.default, locales.supported) })}
          value={newGroup}
          onChange={(event) => setNewGroup(event.target.value)}
        />
        <Button
          variant="secondary"
          disabled={newGroup.trim() === ''}
          onClick={() => {
            const name = newGroup.trim();
            const code = slug(name, new Set(state.groups.map((group) => group.groupCode)));
            setState(addGroup(state, code, { [locales.default]: name }));
            setNewGroup('');
          }}
        >
          {t('add-group')}
        </Button>
      </div>
      {tight.length > 0 ? (
        <Banner tone="info" title={t('impact.title')}>
          {t('impact.body', { count: detail.productCount, attributes: tight.join(', ') })}
        </Banner>
      ) : null}
      {material.length > 0 ? (
        <Banner tone="attention" title={t('material.title')}>
          {t('material.body', { attributes: material.join(', ') })}
        </Banner>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" disabled={pending} onClick={onCancel}>
          {t('cancel')}
        </Button>
        <Button
          loading={pending}
          disabled={!dirty || material.length > 0}
          onClick={() => void save()}
        >
          {t('save')}
        </Button>
      </div>
    </section>
  );
}
