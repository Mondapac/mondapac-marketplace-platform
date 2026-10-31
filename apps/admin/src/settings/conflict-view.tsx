'use client';

import { SettingsConflictCompare, type FieldChange } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/**
 * The "someone saved first" banner of a settings page: the draft is kept, and Compare lists each
 * changed field as "saved now / yours". `changes` are measured against what is saved now, and
 * every value is plain text. `conflictId` starts the list closed for each new conflict. The title
 * is generic: no settings answer says who saved or when.
 */
export function SettingsConflictView({
  conflictId,
  changes,
}: {
  readonly conflictId: number;
  readonly changes: readonly FieldChange[];
}) {
  const t = useTranslations();
  return (
    <SettingsConflictCompare
      key={conflictId}
      title={t('settings.conflict.title')}
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
