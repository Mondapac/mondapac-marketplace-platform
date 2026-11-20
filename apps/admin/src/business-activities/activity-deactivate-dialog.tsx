'use client';

import { Banner, Button, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef } from 'react';
import { API_ACTIVITIES, type ActivityRow, type ActivityWrap } from './types.ts';
import { useActivityCall } from './use-activity-call.ts';

/**
 * Deactivate one business activity (confirmation level 2: it names the activity and what follows,
 * focus starts on Cancel, the confirm button is red). The API changes the status through the edit
 * route with the whole content, so the row's own content goes back unchanged with `inactive`.
 */
export function ActivityDeactivateDialog({
  activity,
  name,
  csrfToken,
  onClose,
  onDone,
  onStale,
}: {
  readonly activity: ActivityRow;
  readonly name: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: (activity: ActivityRow) => void;
  readonly onStale: () => void;
}) {
  const t = useTranslations('business-activities.deactivate');
  const tr = useTranslations();
  const call = useActivityCall(csrfToken);
  const cancel = useRef<HTMLButtonElement>(null);

  async function confirm() {
    const answer = await call.run<ActivityWrap>('PUT', `${API_ACTIVITIES}/${activity.id}`, {
      names: activity.names,
      description: activity.description,
      categoryIds: activity.categoryIds,
      status: 'inactive',
      version: activity.version,
    });
    if (answer.ok) onDone(answer.body.activity);
  }

  const problem = call.problem;
  return (
    <Dialog
      open
      title={t('title', { name })}
      onClose={onClose}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onStale}>{tr('business-activities.form.reload')}</Button>
          ) : (
            <Button
              variant="destructive-solid"
              loading={call.pending}
              disabled={call.pending}
              onClick={() => void confirm()}
            >
              {t('yes')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problem === null ? null : <Banner tone="critical">{tr(problem.key)}</Banner>}
        <p>{t('body', { name })}</p>
      </div>
    </Dialog>
  );
}
