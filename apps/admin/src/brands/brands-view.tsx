'use client';

import { Banner, Button, LoadError, PageHeader, SkeletonRows, Tabs, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import type { ListPagingMode } from '../shared/paged-list/types.ts';
import { BrandConfirmDialog } from './brand-confirm-dialog.tsx';
import { BrandFormDialog } from './brand-form-dialog.tsx';
import { BrandMergeDialog } from './brand-merge-dialog.tsx';
import { BrandsList, type RowDialog } from './brands-list.tsx';
import { MergeQueue } from './merge-queue.tsx';
import { API_QUEUE, type MergeBody, type QueueBody, type QueueGroup } from './types.ts';

type Load = 'loading' | 'ready' | 'failed';
type Section = 'brands' | 'duplicates';

/**
 * The brands of the platform (shared by every Market): the list (Active, Proposed, Archived; a
 * super list) and the possible duplicates (the merge queue). A holder of `catalog.brand.edit`
 * also gets the writes in the row Actions menu; a reader gets the list and no actions. Every
 * decision is confirmed in a dialog and checked again by the API.
 */
export function BrandsView({
  title,
  canEdit,
  csrfToken,
  paging,
  accountId,
  marketId,
  zone,
}: {
  /** The page's h1; the New button sits in its row on the Brands tab. */
  readonly title: string;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
  /** The IANA zone of the table's times and of the Created presets. */
  readonly zone: string;
}) {
  const t = useTranslations('brands');
  const tl = useTranslations('load');
  const [section, setSection] = useState<Section>('brands');
  const [groups, setGroups] = useState<readonly QueueGroup[]>([]);
  const [queueLoad, setQueueLoad] = useState<Load>('loading');
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<RowDialog | null>(null);
  const [refresh, setRefresh] = useState(0);

  const fetchQueue = useCallback(async () => {
    setQueueLoad('loading');
    const result = await callApi<QueueBody>('GET', API_QUEUE);
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setQueueLoad('failed');
      return;
    }
    setGroups(result.body.groups);
    setQueueLoad('ready');
  }, []);

  useEffect(() => {
    void fetchQueue();
  }, [fetchQueue]);

  const refreshAll = useCallback(() => {
    setRefresh((value) => value + 1);
    void fetchQueue();
  }, [fetchQueue]);

  const close = () => setDialog(null);
  // The brand changed or vanished meanwhile: close, say so, and read the lists again.
  const stale = () => {
    close();
    setNotice(t('stale'));
    refreshAll();
  };
  const done = (message: string) => {
    close();
    setNotice(null);
    toast.success(message);
    refreshAll();
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title={title}
        {...(canEdit && section === 'brands'
          ? { actions: <Button onClick={() => setDialog({ kind: 'form' })}>{t('new')}</Button> }
          : {})}
      />
      <Tabs
        label={t('tabs')}
        items={[
          { id: 'brands', label: t('tab.brands'), help: 'Brands' },
          {
            id: 'duplicates',
            help: 'Duplicates',
            label: `${t('tab.duplicates')}${queueLoad === 'ready' ? ` (${groups.length})` : ''}`,
          },
        ]}
        activeId={section}
        onSelect={(id) => {
          setSection(id as Section);
          setNotice(null);
        }}
      />
      {notice === null ? null : <Banner tone="info">{notice}</Banner>}
      {section === 'duplicates' ? (
        queueLoad === 'loading' ? (
          <SkeletonRows label={t('loading')} rows={3} />
        ) : queueLoad === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
            message={t('queue.error')}
            retryLabel={tl('retry')}
            onRetry={() => void fetchQueue()}
          />
        ) : (
          <>
            <MergeQueue
              groups={groups}
              canEdit={canEdit}
              csrfToken={csrfToken}
              onSettled={() => refreshAll()}
            />
          </>
        )
      ) : (
        <BrandsList
          paging={paging}
          accountId={accountId}
          marketId={marketId}
          zone={zone}
          csrfToken={csrfToken}
          refreshKey={refresh}
          onOpen={setDialog}
          headerAction={null}
          dialogs={
            <>
              {dialog?.kind === 'form' ? (
                <BrandFormDialog
                  {...(dialog.brand === undefined ? {} : { brand: dialog.brand })}
                  csrfToken={csrfToken}
                  onClose={close}
                  onStale={stale}
                  onSaved={(brand) => {
                    const created = dialog.brand === undefined;
                    done(t(created ? 'done.created' : 'done.saved', { name: brand.name }));
                  }}
                />
              ) : null}
              {dialog?.kind === 'confirm' ? (
                <BrandConfirmDialog
                  kind={dialog.action}
                  brand={dialog.brand}
                  csrfToken={csrfToken}
                  onClose={close}
                  onStale={stale}
                  onDone={(brand) => done(t(`done.${dialog.action}`, { name: brand.name }))}
                />
              ) : null}
              {dialog?.kind === 'merge' ? (
                <BrandMergeDialog
                  target={dialog.brand}
                  csrfToken={csrfToken}
                  onClose={close}
                  onStale={stale}
                  onMerged={(result: MergeBody) =>
                    done(
                      t('done.merged', {
                        count: result.merged.length,
                        name: result.brand.name,
                        moved: result.merged.reduce((sum, entry) => sum + entry.productsMoved, 0),
                      }),
                    )
                  }
                />
              ) : null}
            </>
          }
        />
      )}
    </div>
  );
}
