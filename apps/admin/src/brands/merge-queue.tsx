'use client';

import { Badge, Banner, Button, Dialog, EmptyState, Select, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { brandProblemOf } from './brand-errors.ts';
import { callApi } from '../api/client.ts';
import {
  API_BRANDS,
  API_QUEUE,
  type MergeBody,
  type QueueBrand,
  type QueueGroup,
} from './types.ts';
import { useBrandCall } from './use-brand-call.ts';

/** The live brand with the most products: the likeliest one to keep. */
export function defaultTarget(group: QueueGroup): string {
  const live = group.brands.filter((brand) => brand.status === 'active');
  const best = [...live].sort((a, b) => b.productCount - a.productCount)[0];
  return best?.id ?? '';
}

/**
 * The merge queue: groups of brands whose names look like one brand. Each group offers the merge
 * into one live brand (behind a confirmation) or keeps the brands apart. Nothing merges by itself.
 */
export function MergeQueue({
  groups,
  canEdit,
  csrfToken,
  onSettled,
}: {
  readonly groups: readonly QueueGroup[];
  readonly canEdit: boolean;
  readonly csrfToken: string;
  /** A group was merged or kept apart: the lists and the counts are read again. */
  readonly onSettled: (groupKey: string) => void;
}) {
  const t = useTranslations('brands.queue');
  if (groups.length === 0) return <EmptyState icon="tag" title={t('empty')} />;
  return (
    <ul className="flex flex-col gap-4">
      {groups.map((group) => (
        <li key={group.groupKey}>
          <GroupCard
            group={group}
            canEdit={canEdit}
            csrfToken={csrfToken}
            onSettled={() => onSettled(group.groupKey)}
          />
        </li>
      ))}
    </ul>
  );
}

function GroupCard({
  group,
  canEdit,
  csrfToken,
  onSettled,
}: {
  readonly group: QueueGroup;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  readonly onSettled: () => void;
}) {
  const t = useTranslations('brands.queue');
  const tr = useTranslations();
  const ts = useTranslations('brands.status');
  const [targetId, setTargetId] = useState(defaultTarget(group));
  const [confirming, setConfirming] = useState(false);
  const [keepProblem, setKeepProblem] = useState<string | null>(null);
  const [keeping, setKeeping] = useState(false);
  const merge = useBrandCall(csrfToken);

  const live = group.brands.filter((brand) => brand.status === 'active');
  const target = group.brands.find((brand) => brand.id === targetId);
  const sources = group.brands.filter(
    (brand) => brand.id !== targetId && brand.status !== 'archived',
  );
  const products = sources.reduce((sum, brand) => sum + brand.productCount, 0);

  async function doMerge() {
    const answer = await merge.run<MergeBody>('POST', `${API_BRANDS}/${targetId}/merge`, {
      sourceBrandIds: sources.map((brand) => brand.id),
    });
    if (!answer.ok) return;
    toast.success(
      t('merged', { count: sources.length, name: target?.name ?? '', moved: products }),
    );
    onSettled();
  }

  async function keepApart() {
    if (keeping) return;
    setKeeping(true);
    setKeepProblem(null);
    const result = await callApi<{ resolved: number }>(
      'POST',
      `${API_QUEUE}/dismiss`,
      { groupKey: group.groupKey },
      csrfToken,
    );
    setKeeping(false);
    if (result.ok) {
      toast.success(t('kept'));
      onSettled();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const problem = brandProblemOf(result.failure);
    setKeepProblem(problem.key);
    if (problem.reload) onSettled();
  }

  const line = (brand: QueueBrand) => (
    <li
      key={brand.id}
      className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 py-2"
    >
      <span className="min-w-0 font-medium wrap-anywhere text-fg">“{brand.name}”</span>
      <span className="flex items-center gap-2 text-sm text-fg-muted">
        {brand.status === 'active' ? null : (
          <Badge tone={brand.status === 'draft' ? 'attention' : 'neutral'}>
            {ts(brand.status)}
          </Badge>
        )}
        <span className="tabular-nums">{t('products', { count: brand.productCount })}</span>
      </span>
    </li>
  );

  const problem = merge.problem;
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <h3 className="text-base font-semibold text-fg">{t('title')}</h3>
      <p className="mt-1 text-sm text-fg-muted">{t('intro')}</p>
      <ul className="mt-2 divide-y divide-line-row">{group.brands.map(line)}</ul>
      {!canEdit ? (
        <p className="mt-3 text-fg-muted">{t('view-only')}</p>
      ) : (
        <div className="mt-3 flex flex-col gap-3">
          {keepProblem === null ? null : <Banner tone="critical">{tr(keepProblem)}</Banner>}
          {live.length === 0 ? (
            <p className="text-sm text-fg-muted">{t('no-live')}</p>
          ) : (
            <div className="w-full sm:w-72">
              <Select
                label={t('target')}
                value={targetId}
                options={live.map((brand) => ({ value: brand.id, label: brand.name }))}
                onChange={(event) => setTargetId(event.target.value)}
              />
            </div>
          )}
          <div className="flex flex-wrap gap-3">
            <Button
              disabled={targetId === '' || sources.length === 0}
              onClick={() => {
                merge.clear();
                setConfirming(true);
              }}
            >
              {t('merge', { count: sources.length, name: target?.name ?? '' })}
            </Button>
            <Button
              variant="secondary"
              loading={keeping}
              disabled={keeping}
              onClick={() => void keepApart()}
            >
              {t('keep-apart')}
            </Button>
          </div>
          <p className="text-sm text-fg-muted">{t('alias-note')}</p>
        </div>
      )}
      {confirming && target !== undefined ? (
        <Dialog
          open
          title={t('confirm-title', { name: target.name })}
          onClose={() => setConfirming(false)}
          actions={
            <>
              <Button
                variant="secondary"
                disabled={merge.pending}
                onClick={() => setConfirming(false)}
              >
                {t('cancel')}
              </Button>
              {problem?.reload === true ? (
                <Button onClick={onSettled}>{tr('brands.form.reload')}</Button>
              ) : (
                <Button
                  loading={merge.pending}
                  disabled={merge.pending}
                  onClick={() => void doMerge()}
                >
                  {t('confirm-yes', { count: sources.length })}
                </Button>
              )}
            </>
          }
        >
          <div className="flex flex-col gap-3">
            {problem === null ? null : <Banner tone="critical">{tr(problem.key)}</Banner>}
            <p>
              {t('confirm-body', { count: sources.length, name: target.name, moved: products })}
            </p>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
