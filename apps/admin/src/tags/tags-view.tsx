'use client';

import { Banner, Button, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ListPagingMode } from '../shared/paged-list/types.ts';
import { TagFormDialog } from './tag-form-dialog.tsx';
import { TagsList, type TagDialog } from './tags-list.tsx';
import { SYNONYMS_MAX, type Locales } from './types.ts';

/**
 * The product tags of the Market (catalog topics: Ramadan, BBQ, ...) as a super list. A holder of
 * `catalog.topic.manage` also gets New tag… and, in each row's Actions menu, Edit…; a reader gets
 * the list and no actions.
 */
export function TagsView({
  canManage,
  csrfToken,
  paging,
  accountId,
  marketId,
}: {
  readonly canManage: boolean;
  readonly csrfToken: string;
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
}) {
  const t = useTranslations('tags');
  const [locales, setLocales] = useState<Locales | null>(null);
  const [maxSynonyms, setMaxSynonyms] = useState(SYNONYMS_MAX);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<TagDialog | null>(null);
  const [refresh, setRefresh] = useState(0);

  const close = () => setDialog(null);
  const reload = () => setRefresh((value) => value + 1);
  // The tag changed or vanished meanwhile: close, say so, and read the list again.
  const stale = () => {
    close();
    setNotice(t('stale'));
    reload();
  };

  return (
    <div className="flex flex-col gap-4">
      {notice === null ? null : <Banner tone="info">{notice}</Banner>}
      <TagsList
        paging={paging}
        accountId={accountId}
        marketId={marketId}
        csrfToken={csrfToken}
        locale={locales?.default ?? 'en'}
        onOpen={setDialog}
        onAnswered={(answer) => {
          setLocales(answer.locales);
          setMaxSynonyms(answer.maxSynonyms);
        }}
        refreshKey={refresh}
        headerAction={
          canManage && locales !== null ? (
            <Button onClick={() => setDialog({ kind: 'form' })}>{t('new')}</Button>
          ) : null
        }
        dialogs={
          dialog?.kind === 'form' && locales !== null ? (
            <TagFormDialog
              {...(dialog.topic === undefined ? {} : { topic: dialog.topic })}
              locales={locales}
              maxSynonyms={maxSynonyms}
              csrfToken={csrfToken}
              onClose={close}
              onStale={stale}
              onSaved={(topic) => {
                close();
                setNotice(null);
                toast.success(
                  t(dialog.topic === undefined ? 'done.created' : 'done.saved', {
                    name: topic.names[locales.default] ?? topic.slug,
                  }),
                );
                reload();
              }}
            />
          ) : null
        }
      />
    </div>
  );
}
