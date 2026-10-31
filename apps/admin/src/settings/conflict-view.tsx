'use client';

import { SettingsConflictCompare, type FieldChange, type LastChangedValue } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useWinnerTitle } from './last-changed.tsx';

/**
 * The "someone saved first" banner of a settings page: the draft is kept, and Compare lists each
 * changed field as "saved now / yours". `changes` are measured against what is saved now, and
 * every value is plain text. `conflictId` starts the list closed for each new conflict. The title
 * names who saved first and when ("Sara K. saved these settings 1 minute ago") from `winner`, the
 * `lastChanged` of the settings read again after the conflict; without a name it stays generic.
 * `subject` is what was saved, worded in `settings.conflict.subject-*`.
 */
export function SettingsConflictView({
  conflictId,
  changes,
  winner,
  subject = 'settings',
}: {
  readonly conflictId: number;
  readonly changes: readonly FieldChange[];
  readonly winner?: LastChangedValue | null;
  readonly subject?: 'settings' | 'store-profile';
}) {
  const t = useTranslations();
  const winnerTitle = useWinnerTitle();
  const title = winnerTitle(winner, subject) ?? t('settings.conflict.title');
  return (
    <SettingsConflictCompare
      key={conflictId}
      title={title}
      body={t('settings.conflict.body', { count: changes.length })}
      compareLabel={t('settings.conflict.compare')}
      hideLabel={t('settings.conflict.hide')}
      heading={t('settings.conflict.heading')}
      listLabel={t('settings.conflict.list-label')}
      savedLabel={t('settings.conflict.saved-label')}
      yoursLabel={t('settings.conflict.yours-label')}
      sameText={t('settings.conflict.same')}
      rows={changes}
    />
  );
}
