'use client';

import { Banner, Button, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import type { ListPagingMode } from '../shared/paged-list/types.ts';
import { ActivityDeactivateDialog } from './activity-deactivate-dialog.tsx';
import { ActivityFormDialog } from './activity-form-dialog.tsx';
import { ActivitiesList, type ActivityDialog } from './activities-list.tsx';
import type { Locales } from './types.ts';

/**
 * The business activities of the Market (Grocery, Butcher, ...) as a super list. A holder of
 * `catalog.business-activity.edit` also gets New activity… and, in each row's Actions menu, Edit…
 * and Deactivate…; a reader gets the list and no actions.
 */
export function BusinessActivitiesView({
  canEdit,
  csrfToken,
  paging,
  accountId,
  marketId,
}: {
  readonly canEdit: boolean;
  readonly csrfToken: string;
  readonly paging: ListPagingMode;
  readonly accountId: string;
  readonly marketId: string;
}) {
  const t = useTranslations('business-activities');
  const [locales, setLocales] = useState<Locales | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<ActivityDialog | null>(null);
  const [refresh, setRefresh] = useState(0);

  const close = () => setDialog(null);
  const reload = () => setRefresh((value) => value + 1);
  // The activity changed or vanished meanwhile: close, say so, and read the list again.
  const stale = () => {
    close();
    setNotice(t('stale'));
    reload();
  };
  const defaultLocale = locales?.default ?? 'en';

  return (
    <div className="flex flex-col gap-4">
      {notice === null ? null : <Banner tone="info">{notice}</Banner>}
      <ActivitiesList
        paging={paging}
        accountId={accountId}
        marketId={marketId}
        csrfToken={csrfToken}
        locale={defaultLocale}
        onOpen={setDialog}
        onLocales={setLocales}
        refreshKey={refresh}
        headerAction={
          canEdit && locales !== null ? (
            <Button onClick={() => setDialog({ kind: 'form' })}>{t('new')}</Button>
          ) : null
        }
        dialogs={
          <>
            {dialog?.kind === 'form' && locales !== null ? (
              <ActivityFormDialog
                {...(dialog.activity === undefined ? {} : { activity: dialog.activity })}
                locales={locales}
                csrfToken={csrfToken}
                onClose={close}
                onStale={stale}
                onSaved={(activity) => {
                  close();
                  setNotice(null);
                  toast.success(
                    t(dialog.activity === undefined ? 'done.created' : 'done.saved', {
                      name: activity.names[locales.default] ?? activity.code,
                    }),
                  );
                  reload();
                }}
              />
            ) : null}
            {dialog?.kind === 'deactivate' ? (
              <ActivityDeactivateDialog
                activity={dialog.activity}
                name={dialog.activity.names[defaultLocale] ?? dialog.activity.code}
                csrfToken={csrfToken}
                onClose={close}
                onStale={stale}
                onDone={(activity) => {
                  close();
                  setNotice(null);
                  toast.success(
                    t('done.deactivated', {
                      name: activity.names[defaultLocale] ?? activity.code,
                    }),
                  );
                  reload();
                }}
              />
            ) : null}
          </>
        }
      />
    </div>
  );
}
