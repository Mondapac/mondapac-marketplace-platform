'use client';

import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  LoadError,
  Select,
  SkeletonRows,
  TextField,
  toast,
  type BadgeTone,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { languageName } from '../../attributes/types.ts';
import { directionOf } from '../tree-model.ts';
import type { TreeBody } from '../types.ts';
import { headline, mergeTargets, pathText, SLUG_SHAPE, suggestSlug } from './model.ts';
import {
  API_SHELVES,
  sellerShelvesPath,
  type Shelf,
  type ShelfList,
  type ShelfMerged,
  type ShelfPromoted,
} from './types.ts';
import { useWrite } from './use-write.ts';

const TONE: Record<string, BadgeTone> = {
  active: 'success',
  promoted: 'info',
  merged: 'neutral',
  archived: 'neutral',
};

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly shelves: readonly Shelf[] }
  | { readonly state: 'denied' }
  | { readonly state: 'failed' };

/**
 * One seller's shelves (categories C9b; CAT-52, CAT-53). An admin who holds the protected
 * promote-merge key can Promote an active shelf into the platform tree (created hidden) or Merge
 * it into a live platform category. Shelves are not platform categories: neither action moves a
 * published revision, and both clear the shelf on the seller's Offers.
 */
export function ShelvesPanel({
  sellerId,
  storeName,
  tree,
  canPromote,
  csrfToken,
  onClose,
  onTreeChanged,
}: {
  readonly sellerId: string;
  readonly storeName: string | null;
  readonly tree: TreeBody;
  readonly canPromote: boolean;
  readonly csrfToken: string;
  readonly onClose: () => void;
  /** A promote added a platform category: read the tree again (its version moved). */
  readonly onTreeChanged: () => void;
}) {
  const t = useTranslations('categories.proposals.shelves');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [dialog, setDialog] = useState<{ kind: 'promote' | 'merge'; shelf: Shelf } | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const fetchShelves = useCallback(async () => {
    const answer = await callApi<ShelfList>('GET', sellerShelvesPath(sellerId));
    if (answer.ok) {
      setLoad({ state: 'ready', shelves: answer.body.shelves });
      return;
    }
    if (answer.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: answer.failure.status === 403 ? 'denied' : 'failed' });
  }, [sellerId]);

  useEffect(() => {
    void fetchShelves();
  }, [fetchShelves]);

  const heading = storeName ?? t('this-seller');
  return (
    <section
      aria-labelledby="shelves-heading"
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id="shelves-heading" className="text-lg font-semibold text-fg">
          {t('title', { store: heading })}
        </h2>
        <Button variant="secondary" onClick={onClose}>
          {t('close')}
        </Button>
      </div>
      <p className="max-w-prose text-fg-muted">{t('intro')}</p>
      <div role="status" className="min-h-5 text-sm text-fg-muted">
        {result}
      </div>
      {load.state === 'loading' ? <SkeletonRows label={t('loading')} rows={2} /> : null}
      {load.state === 'denied' ? <Banner tone="info">{t('denied')}</Banner> : null}
      {load.state === 'failed' ? (
        <LoadError
          message={t('load-failed')}
          retryLabel={tl('retry')}
          onRetry={() => {
            setLoad({ state: 'loading' });
            void fetchShelves();
          }}
        />
      ) : null}
      {load.state === 'ready' && load.shelves.length === 0 ? (
        <EmptyState size="card" icon="layout" title={t('empty')} />
      ) : null}
      {load.state === 'ready' && load.shelves.length > 0 ? (
        <ul className="flex flex-col gap-3" aria-label={t('list-label', { store: heading })}>
          {load.shelves.map((shelf) => {
            const name = headline(shelf.texts, tree.defaultLocale);
            return (
              <li key={shelf.id} className="rounded-md border border-line p-3">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="min-w-0 text-base font-semibold wrap-anywhere text-fg">{name}</h3>
                  <Badge tone={TONE[shelf.status] ?? 'neutral'}>
                    {t(`status.${shelf.status}`)}
                  </Badge>
                </div>
                <p className="mt-1 text-sm text-fg-muted">
                  {t('under', {
                    path:
                      pathText(tree.categories, shelf.platformParentId, tree.defaultLocale) || '-',
                  })}
                </p>
                <ul className="mt-2 flex flex-col gap-1">
                  {shelf.texts.map((text) => (
                    <li key={text.locale} className="text-sm">
                      <span className="text-fg-muted">
                        {languageName(text.locale, tree.supportedLocales)}:{' '}
                      </span>
                      <span lang={text.locale} dir={directionOf(text.locale)}>
                        {text.name}
                      </span>
                    </li>
                  ))}
                </ul>
                {shelf.status === 'active' && canPromote ? (
                  <div className="mt-3 flex flex-wrap gap-3">
                    <Button
                      aria-label={t('promote-for', { name })}
                      onClick={() => setDialog({ kind: 'promote', shelf })}
                    >
                      {t('promote')}
                    </Button>
                    <Button
                      variant="secondary"
                      aria-label={t('merge-for', { name })}
                      onClick={() => setDialog({ kind: 'merge', shelf })}
                    >
                      {t('merge')}
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
      {dialog?.kind === 'promote' ? (
        <PromoteDialog
          shelf={dialog.shelf}
          tree={tree}
          csrfToken={csrfToken}
          onClose={() => setDialog(null)}
          onDone={(done) => {
            setDialog(null);
            setResult(t('done.promote', { n: done.offersCleared }));
            toast.success(t('done.promote', { n: done.offersCleared }));
            void fetchShelves();
            onTreeChanged();
          }}
          onReload={() => {
            setDialog(null);
            void fetchShelves();
            onTreeChanged();
          }}
        />
      ) : null}
      {dialog?.kind === 'merge' ? (
        <MergeDialog
          shelf={dialog.shelf}
          tree={tree}
          csrfToken={csrfToken}
          onClose={() => setDialog(null)}
          onDone={(done) => {
            setDialog(null);
            setResult(t('done.merge', { n: done.offersCleared }));
            toast.success(t('done.merge', { n: done.offersCleared }));
            void fetchShelves();
          }}
          onReload={() => {
            setDialog(null);
            void fetchShelves();
            onTreeChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function DialogProblem({
  problem,
}: {
  readonly problem: { readonly key: string; readonly max?: number } | null;
}) {
  const t = useTranslations('categories.proposals');
  if (problem === null) return null;
  return (
    <div role="alert">
      <Banner tone="critical">{t(`error.${problem.key}`, { max: problem.max ?? 0 })}</Banner>
    </div>
  );
}

function PromoteDialog({
  shelf,
  tree,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly shelf: Shelf;
  readonly tree: TreeBody;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (done: ShelfPromoted) => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.proposals.promote');
  const write = useWrite(csrfToken);
  const name = headline(shelf.texts, tree.defaultLocale);
  const [slug, setSlug] = useState(() => suggestSlug(shelf.texts));
  const slugBad = slug === '' || slug.length < 2 || slug.length > 80 || !SLUG_SHAPE.test(slug);
  const parent = pathText(tree.categories, shelf.platformParentId, tree.defaultLocale);

  async function submit() {
    if (slugBad) return;
    const answer = await write.run<ShelfPromoted>(`${API_SHELVES}/${shelf.id}/promote`, {
      version: shelf.version,
      slug,
      treeVersion: tree.treeVersion,
    });
    if (answer.ok) onDone(answer.body);
  }

  return (
    <Dialog
      open
      title={t('title', { name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={write.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {write.problem?.reload === true ? (
            <Button onClick={onReload}>{t('reload')}</Button>
          ) : (
            <Button loading={write.pending} disabled={slugBad} onClick={() => void submit()}>
              {t('confirm')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <DialogProblem problem={write.problem} />
        <Banner tone="info">{t('not-platform')}</Banner>
        <p className="m-0">{t('what', { name, parent: parent === '' ? '-' : parent })}</p>
        <section aria-label={t('impact-title')} className="flex flex-col gap-1">
          <h3 className="m-0 text-base font-semibold">{t('impact-title')}</h3>
          <ul className="m-0 list-disc ps-5">
            <li>{t('impact-hidden')}</li>
            <li>{t('impact-offers')}</li>
            <li>{t('impact-published')}</li>
          </ul>
        </section>
        <TextField
          name="slug"
          label={t('slug')}
          help={t('slug-help')}
          value={slug}
          maxLength={80}
          dir="ltr"
          autoComplete="off"
          error={slug !== '' && slugBad ? t('slug-bad') : undefined}
          onChange={(event) => {
            write.clear();
            setSlug(event.target.value.trim().toLowerCase());
          }}
        />
      </div>
    </Dialog>
  );
}

function MergeDialog({
  shelf,
  tree,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly shelf: Shelf;
  readonly tree: TreeBody;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (done: ShelfMerged) => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.proposals.merge');
  const write = useWrite(csrfToken);
  const name = headline(shelf.texts, tree.defaultLocale);
  const [target, setTarget] = useState('');
  const options = useMemo(
    () => mergeTargets(tree.categories, tree.defaultLocale),
    [tree.categories, tree.defaultLocale],
  );

  async function submit() {
    if (target === '') return;
    const answer = await write.run<ShelfMerged>(`${API_SHELVES}/${shelf.id}/merge`, {
      version: shelf.version,
      categoryId: target,
    });
    if (answer.ok) onDone(answer.body);
  }

  return (
    <Dialog
      open
      title={t('title', { name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={write.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {write.problem?.reload === true ? (
            <Button onClick={onReload}>{t('reload')}</Button>
          ) : (
            <Button loading={write.pending} disabled={target === ''} onClick={() => void submit()}>
              {t('confirm')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <DialogProblem problem={write.problem} />
        <Banner tone="info">{t('not-platform')}</Banner>
        <p className="m-0">{t('what', { name })}</p>
        <section aria-label={t('impact-title')} className="flex flex-col gap-1">
          <h3 className="m-0 text-base font-semibold">{t('impact-title')}</h3>
          <ul className="m-0 list-disc ps-5">
            <li>{t('impact-offers')}</li>
            <li>{t('impact-terminal')}</li>
            <li>{t('impact-published')}</li>
          </ul>
        </section>
        <Select
          label={t('target')}
          placeholder={t('target-choose')}
          value={target}
          options={options}
          onChange={(event) => {
            write.clear();
            setTarget(event.target.value);
          }}
        />
      </div>
    </Dialog>
  );
}
