'use client';

import { Banner, EmptyState, LoadError, SkeletonRows, Select, TextField } from '@mondapac/ui';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { CategoryDetails } from './category-details.tsx';
import { CategoryTree } from './category-tree.tsx';
import { branchIds, indexOf, isFiltering, visibleRows } from './tree-model.ts';
import {
  API_CATEGORIES,
  CATEGORIES_PATH,
  STATUS_FILTERS,
  type StatusFilter,
  type TreeBody,
} from './types.ts';

type Load = 'loading' | 'ready' | 'failed';
const WIDE = '(min-width: 1024px)';

/**
 * The category tree of the Market with the details of the picked category beside it. Read only:
 * a reader and an editor see the same page today. From 1024 px the details sit in a third column;
 * below it the tree takes the width and a pick opens the details as a page of their own.
 */
export function CategoriesView({ canEdit }: { readonly canEdit: boolean }) {
  const t = useTranslations('categories');
  const tl = useTranslations('load');
  const router = useRouter();
  const [load, setLoad] = useState<Load>('loading');
  const [tree, setTree] = useState<TreeBody | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<StatusFilter>('all');
  const latest = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setQ(typed.trim()), 250);
    return () => clearTimeout(timer);
  }, [typed]);

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
    setExpanded(new Set(result.body.categories.filter((c) => c.depth === 0).map((c) => c.id)));
    setLoad('ready');
  }, []);

  useEffect(() => {
    void fetchTree();
  }, [fetchTree]);

  const rows = tree?.categories ?? [];
  const filter = useMemo(() => ({ q, status }), [q, status]);
  const list = useMemo(() => visibleRows(rows, expanded, filter), [rows, expanded, filter]);

  const countText = (n: number): string =>
    tree?.complete === false ? t('at-least', { n }) : String(n);

  function pick(id: string) {
    if (typeof window.matchMedia === 'function' && !window.matchMedia(WIDE).matches) {
      router.push(`${CATEGORIES_PATH}/${id}`);
      return;
    }
    setSelectedId(id);
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

  if (load === 'loading') return <SkeletonRows label={t('loading')} rows={6} />;
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
  if (rows.length === 0) return <EmptyState icon="layout" title={t('empty')} />;

  return (
    <div className="flex flex-col gap-4">
      <p className="max-w-prose text-fg-muted">{t('intro')}</p>
      {canEdit ? null : <Banner tone="info">{t('view-only')}</Banner>}
      {tree.complete ? null : <Banner tone="info">{t('counts-partial')}</Banner>}
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
                label={t('status-label')}
                value={status}
                options={STATUS_FILTERS.map((value) => ({
                  value,
                  label: t(`filter.${value}`),
                }))}
                onChange={(event) => setStatus(event.target.value as StatusFilter)}
              />
            </div>
          </div>
          {list.length === 0 ? (
            <EmptyState icon="layout" title={t('empty-search', { q })} />
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
          className="hidden rounded-lg border border-line bg-surface p-4 lg:block"
        >
          {selectedId === null ? (
            <p className="text-fg-muted">{t('details.pick')}</p>
          ) : (
            <CategoryDetails key={selectedId} id={selectedId} canEdit={canEdit} />
          )}
        </aside>
      </div>
    </div>
  );
}
