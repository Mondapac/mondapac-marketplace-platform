'use client';

import { Banner, EmptyState, LoadError, SkeletonRows, Select, TextField } from '@mondapac/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { API_FEATURE_SETS, type FeatureSetList } from '../attributes/types.ts';
import { CategoryDetails } from './category-details.tsx';
import { CreateCategoryDialog } from './category-dialogs.tsx';
import { CategoryTree } from './category-tree.tsx';
import { TreeFileActions } from './import/tree-file-actions.tsx';
import { languageName } from '../business-activities/activity-form.ts';
import { Button } from '@mondapac/ui';
import { branchIds, indexOf, isFiltering, missingCounts, visibleRows } from './tree-model.ts';
import {
  API_CATEGORIES,
  CATEGORIES_PATH,
  STATUS_FILTERS,
  type StatusFilter,
  type TreeBody,
} from './types.ts';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
type Load = 'loading' | 'ready' | 'failed';
const WIDE = '(min-width: 1024px)';

/**
 * The category tree of the Market with the details of the picked category beside it. Read only:
 * a reader and an editor see the same page today. From 1024 px the details sit in a third column;
 * below it the tree takes the width and a pick opens the details as a page of their own.
 */
export function CategoriesView({
  canEdit,
  canRestructure = false,
  csrfToken = '',
  canImport = false,
}: {
  readonly canEdit: boolean;
  /** `catalog.category-tree.import`: Export the tree and Import from a file. */
  readonly canImport?: boolean;
  /** `catalog.category-tree.restructure`: Move, Merge and Archive. */
  readonly canRestructure?: boolean;
  readonly csrfToken?: string;
}) {
  const t = useTranslations('categories');
  const tl = useTranslations('load');
  const router = useRouter();
  const [load, setLoad] = useState<Load>('loading');
  const [tree, setTree] = useState<TreeBody | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The picked category is kept in the address (`?c=<id>`), so a reload or a shared link opens it.
  const choose = (id: string | null) => {
    setSelectedId(id);
    try {
      const url = new URL(window.location.href);
      if (id === null) url.searchParams.delete('c');
      else url.searchParams.set('c', id);
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // A browser that refuses the address change still has the pick in the page.
    }
  };
  useEffect(() => {
    const wanted = new URLSearchParams(window.location.search).get('c');
    if (wanted !== null && UUID_SHAPE.test(wanted)) setSelectedId(wanted);
  }, []);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const [missing, setMissing] = useState('');
  const [featureSet, setFeatureSet] = useState('');
  const [sets, setSets] = useState<FeatureSetList['items']>([]);
  const [adding, setAdding] = useState(false);
  const [version, setVersion] = useState(0);
  const latest = useRef(0);
  // What the last write says (read out politely, also shown), and the row to focus once the tree
  // has been read again.
  const [note, setNote] = useState<string | null>(null);
  const focusAfter = useRef<string | null>(null);

  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);

  // The feature sets the filter offers; if they cannot be read, the filter is left out.
  useEffect(() => {
    let live = true;
    void callApi<FeatureSetList>('GET', API_FEATURE_SETS).then((r) => {
      if (live && r.ok) setSets(r.body?.items ?? []);
    });
    return () => {
      live = false;
    };
  }, []);

  const fetchTree = useCallback(async () => {
    const ticket = ++latest.current;
    setLoad('loading');
    const result = await callApi<TreeBody>('GET', API_CATEGORIES);
    if (ticket !== latest.current) return;
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setLoad('failed');
      return;
    }
    setTree(result.body);
    // The departments start open, so the first level of groups is in view.
    setExpanded((previous) =>
      previous.size > 0
        ? previous
        : new Set(result.body.categories.filter((c) => c.depth === 0).map((c) => c.id)),
    );
    setLoad('ready');
  }, []);

  useEffect(() => {
    void fetchTree();
  }, [fetchTree]);

  const rows = tree?.categories ?? [];
  const filter = useMemo(
    () => ({
      q,
      status,
      missing: missing === '' ? null : missing,
      featureSetId: featureSet === '' ? null : featureSet,
    }),
    [q, status, missing, featureSet],
  );
  const missingByLocale = useMemo(
    () => missingCounts(rows, tree?.supportedLocales ?? []),
    [rows, tree],
  );
  const list = useMemo(() => visibleRows(rows, expanded, filter), [rows, expanded, filter]);

  // After a write the tree is read again: focus goes to the row the admin worked on (the moved
  // one, the new one, the one whose dialog closed). A row that is gone gets no focus.
  useEffect(() => {
    const id = focusAfter.current;
    if (id === null || load !== 'ready') return;
    // One try after the tree is read again; a row that is gone gets no focus and no later retry.
    focusAfter.current = null;
    document.querySelector<HTMLElement>(`[data-row-id="${id}"]`)?.focus();
  }, [list, load]);

  const countText = (n: number): string =>
    tree?.complete === false && n > 0 ? t('at-least', { n }) : String(n);

  /** A change was saved: read the tree again; the details of the picked category are read again. */
  function changed(message?: string, focusId?: string) {
    setNote(message ?? null);
    focusAfter.current = focusId ?? selectedId;
    setVersion((n) => n + 1);
    void fetchTree();
  }
  /** A category was added: read the tree again, open its parent and pick it. */
  function created(id: string, parentId: string | null) {
    if (parentId !== null) setOpen(parentId, true);
    choose(id);
    changed(t('toolbar.note-add'), id);
  }
  function pick(id: string) {
    if (typeof window.matchMedia === 'function' && !window.matchMedia(WIDE).matches) {
      router.push(`${CATEGORIES_PATH}/${id}`);
      return;
    }
    choose(id);
  }
  function setOpen(id: string, open: boolean) {
    setExpanded((previous) => {
      const next = new Set(previous);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });
  }
  function openSiblings(id: string) {
    const { byId, children } = indexOf(rows);
    const parent = byId.get(id)?.parentId ?? null;
    const branches = branchIds(rows);
    setExpanded((previous) => {
      const next = new Set(previous);
      for (const sibling of children.get(parent) ?? []) {
        if (branches.has(sibling.id)) next.add(sibling.id);
      }
      return next;
    });
  }

  if (load === 'loading' && tree === null) return <SkeletonRows label={t('loading')} rows={6} />;
  if (load === 'failed' || tree === null) {
    return (
      <LoadError
        className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
        message={t('load-error')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchTree()}
      />
    );
  }
  if (rows.length === 0 && !canEdit) return <EmptyState icon="layout" title={t('empty')} />;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-fg-muted">{canEdit ? t('intro-edit') : t('intro')}</p>
      {canImport ? <TreeFileActions /> : null}
      {canEdit ? null : <Banner tone="info">{t('view-only')}</Banner>}
      {tree.complete ? null : <Banner tone="info">{t('counts-partial')}</Banner>}
      <p role="status" className="m-0 min-h-5 text-sm text-fg-muted">
        {note}
      </p>
      <div className="grid gap-6 lg:grid-cols-3">
        <section aria-label={t('tree-label')} className="flex flex-col gap-3 lg:col-span-2">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
            <div role="search" aria-label={t('search-label')} className="w-full sm:w-72">
              <TextField
                name="search"
                type="search"
                label={t('search')}
                value={typed}
                autoComplete="off"
                onChange={(event) => setTyped(event.target.value)}
              />
            </div>
            <div className="w-full sm:w-48">
              <Select
                label={t('missing-label')}
                value={missing}
                options={[
                  { value: '', label: t('missing-none') },
                  ...tree.supportedLocales.map((locale) => ({
                    value: locale,
                    label: t('missing-option', {
                      language: languageName(locale),
                      count: missingByLocale[locale] ?? 0,
                    }),
                  })),
                ]}
                onChange={(event) => setMissing(event.target.value)}
              />
            </div>
            <div className="w-full sm:w-48">
              <Select
                label={t('status-label')}
                value={status}
                options={STATUS_FILTERS.map((value) => ({
                  value,
                  label: t(`filter.${value}`),
                }))}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
              />
            </div>
            {sets.length === 0 ? null : (
              <div className="w-full sm:w-48">
                <Select
                  label={t('feature-set-label')}
                  value={featureSet}
                  options={[
                    { value: '', label: t('feature-set-all') },
                    ...sets.map((row) => ({ value: row.id, label: row.code })),
                  ]}
                  onChange={(event) => setFeatureSet(event.target.value)}
                />
              </div>
            )}
          </div>
          {canEdit ? (
            <div>
              <Button variant="secondary" onClick={() => setAdding(true)}>
                {t('add-category')}
              </Button>
            </div>
          ) : null}
          {list.length === 0 ? (
            <EmptyState
              icon="layout"
              title={
                rows.length === 0
                  ? t('empty')
                  : q === ''
                    ? t('empty-status')
                    : t('empty-search', { q })
              }
            />
          ) : (
            <div className="rounded-lg border border-line bg-surface">
              <CategoryTree
                label={t('tree-label')}
                list={list}
                locale={tree.defaultLocale}
                selectedId={selectedId}
                countText={countText}
                onSelect={pick}
                onExpand={setOpen}
                onExpandSiblings={openSiblings}
              />
            </div>
          )}
          {isFiltering(filter) ? <p className="text-sm text-fg-muted">{t('filter-note')}</p> : null}
        </section>
        <aside
          aria-label={t('details.label')}
          className="hidden rounded-lg border border-line bg-surface p-4 lg:sticky lg:top-4 lg:block lg:max-h-[calc(100vh-2rem)] lg:self-start lg:overflow-y-auto"
        >
          {selectedId === null ? (
            <p className="text-fg-muted">{t('details.pick')}</p>
          ) : (
            <CategoryDetails
              key={`${selectedId}-${version}`}
              id={selectedId}
              tree={tree}
              canEdit={canEdit}
              canRestructure={canRestructure}
              csrfToken={csrfToken}
              onChanged={changed}
              onCreated={created}
            />
          )}
        </aside>
      </div>
      {adding ? (
        <CreateCategoryDialog
          parent={null}
          parentName={null}
          treeVersion={tree.treeVersion}
          supportedLocales={tree.supportedLocales}
          requiredLocales={tree.requiredLocales}
          csrfToken={csrfToken}
          onClose={() => setAdding(false)}
          onCreated={(id) => {
            setAdding(false);
            created(id, null);
          }}
          onReload={() => {
            setAdding(false);
            changed();
          }}
        />
      ) : null}
    </div>
  );
}
