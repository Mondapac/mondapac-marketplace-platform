'use client';

import { SaveBar, useUnsavedChangesGuard } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/**
 * The shared save bar of an admin editor that is not a settings page: "Unsaved changes",
 * Discard and the editor's own save verb ("Save to draft"), in the panel's words. It belongs
 * inside the editor's form (its Save is a submit button). An optional note under it says what
 * saving does ("Buyers see it after a platform admin approves it").
 */
export function FormSaveBar({
  dirty,
  saving,
  saveLabel,
  onDiscard,
  note,
  emptySummary,
}: {
  readonly dirty: boolean;
  readonly saving: boolean;
  /** The primary verb; the default is "Save changes". */
  readonly saveLabel?: string;
  readonly onDiscard: () => void;
  readonly note?: ReactNode;
  /** A new record is unsaved by definition: the bar then shows with this text before any edit. */
  readonly emptySummary?: string;
}) {
  const t = useTranslations('settings.bar');
  const save = saveLabel ?? t('save');
  return (
    <>
      {note === undefined ? null : <p className="m-0 text-sm text-fg-muted">{note}</p>}
      <SaveBar
        count={dirty ? 1 : 0}
        summary={t('unsaved')}
        {...(emptySummary === undefined ? {} : { emptySummary })}
        saving={saving}
        labels={{
          region: t('region'),
          discard: t('discard'),
          save,
          // The editor keeps its own verb while it saves; the button shows the spinner.
          saving: save,
        }}
        onDiscard={onDiscard}
      />
    </>
  );
}

/** The shared "Leave without saving?" guard, in the panel's words, for an editor's page. */
export function useEditorLeaveGuard(dirty: boolean, page: string): ReactNode {
  const t = useTranslations('settings.leave');
  const guard = useUnsavedChangesGuard(
    dirty,
    {
      title: t('title'),
      message: (info) => t('message', { count: info.count, page: info.page }),
      stay: t('stay'),
      leave: t('leave'),
    },
    { count: 1, page },
  );
  // The dialog is only in the page while there is something to lose.
  return dirty ? guard.dialog : null;
}
