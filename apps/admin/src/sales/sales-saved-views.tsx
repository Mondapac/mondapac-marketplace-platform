'use client';

import {
  ManageViewsDialog,
  SaveViewDialog,
  toast,
  type SavedViewItem,
  type SavedViewLabels,
  type SavedViewVisibility,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useMemo } from 'react';
import { callApi } from '../api/client.ts';
import {
  SAVED_LIMITS,
  problemOf,
  type SavedFilter,
  type SavedFiltersAnswer,
} from './sales-saved.ts';

const TOAST = { id: 'sales-saved-filter' };

/** Every word of the saved-view dialogs, from the shared `sales-lists.saved` messages. */
function useLabels(): SavedViewLabels {
  const t = useTranslations('sales-lists.saved');
  return useMemo(
    () => ({
      cancel: t('cancel'),
      visibility: { me: t('visibility.me'), everyone: t('visibility.everyone') },
      save: {
        title: t('save.title'),
        submit: t('save.submit'),
        name: t('save.name'),
        who: t('save.who'),
        everyoneHelp: t('save.everyone-help'),
        ownOnly: t('save.own-only'),
      },
      manage: {
        title: t('manage.title'),
        close: t('manage.close'),
        empty: t('manage.empty'),
        emptyHelp: t('manage.empty-help'),
        helpShare: t('manage.help-share'),
        helpOwn: t('manage.help-own'),
        sharedByOther: t('manage.shared-by-other'),
        edit: t('manage.edit'),
        delete: t('manage.delete'),
        save: t('manage.save'),
        deleteConfirm: t('manage.delete-confirm'),
        editNamed: (name) => t('manage.edit-named', { name }),
        deleteNamed: (name) => t('manage.delete-named', { name }),
        deleteOwn: (name) => t('manage.delete-own', { name }),
        deleteShared: (name) => t('manage.delete-shared', { name }),
        moveUp: (name) => t('manage.move-up', { name }),
        moveDown: (name) => t('manage.move-down', { name }),
      },
      error: (problem) =>
        t(`error.${problem}`, {
          max: problem === 'shared-limit' ? SAVED_LIMITS.shared : SAVED_LIMITS.perOwner,
        }),
    }),
    [t],
  );
}

/**
 * The Save filter and Manage filters dialogs of a Sales list, wired to the generic saved-filter
 * routes. The list owns the saved filters it shows; this asks it to reload after each change.
 */
export function SalesSavedViews<P>({
  dialog,
  onClose,
  listKey,
  payload,
  summary,
  saved,
  csrfToken,
  idPrefix,
  onSaved,
  onChanged,
}: {
  readonly dialog: 'save' | 'manage' | null;
  readonly onClose: () => void;
  readonly listKey: string;
  /** The closed document that saves what the list shows now (canonical form). */
  readonly payload: P;
  /** What the filter holds, in words. */
  readonly summary: string;
  readonly saved: SavedFiltersAnswer<P>;
  readonly csrfToken: string;
  readonly idPrefix: string;
  /** A new filter was saved: the list reloads and shows it. */
  readonly onSaved: (filter: SavedFilter<P>) => void;
  /** A filter was renamed, shared, deleted or moved: the list reloads. */
  readonly onChanged: () => void;
}) {
  const t = useTranslations('sales-lists.saved');
  const labels = useLabels();
  const views: readonly SavedViewItem[] = saved.items;

  return (
    <>
      <SaveViewDialog
        open={dialog === 'save'}
        onClose={onClose}
        summary={summary}
        canShare={saved.canShare}
        labels={labels}
        idPrefix={idPrefix}
        onSave={async (name, visibility: SavedViewVisibility) => {
          const result = await callApi<SavedFilter<P>>(
            'POST',
            'lists/admin/saved-filters',
            { listKey, name, visibility, payload },
            csrfToken,
          );
          if (!result.ok) return problemOf(result.failure);
          toast.success(t('toast.saved', { name: result.body.name }), TOAST);
          onSaved(result.body);
          return null;
        }}
      />
      <ManageViewsDialog
        open={dialog === 'manage'}
        onClose={onClose}
        views={views}
        canShare={saved.canShare}
        labels={labels}
        idPrefix={idPrefix}
        onRename={async (id, name, visibility) => {
          const result = await callApi<SavedFilter<P>>(
            'PUT',
            `lists/admin/saved-filters/${id}`,
            { listKey, name, visibility },
            csrfToken,
          );
          if (!result.ok) return problemOf(result.failure);
          toast.success(t('toast.updated', { name: result.body.name }), TOAST);
          onChanged();
          return null;
        }}
        onDelete={async (id) => {
          const name = saved.items.find((item) => item.id === id)?.name ?? '';
          const result = await callApi<{ id: string }>(
            'DELETE',
            `lists/admin/saved-filters/${id}?listKey=${listKey}`,
            undefined,
            csrfToken,
          );
          // A filter already gone is what the admin wanted: say so and refresh the list.
          if (!result.ok && result.failure.code !== 'saved-filter.not-found') {
            return problemOf(result.failure);
          }
          toast.success(t('toast.deleted', { name }), TOAST);
          onChanged();
          return null;
        }}
        onReorder={async (ids, movedId) => {
          const result = await callApi<{ ids: readonly string[] }>(
            'PUT',
            'lists/admin/saved-filters/order',
            { listKey, ids },
            csrfToken,
          );
          if (!result.ok) return problemOf(result.failure);
          toast.success(
            t('toast.moved', { name: saved.items.find((item) => item.id === movedId)?.name ?? '' }),
            TOAST,
          );
          onChanged();
          return null;
        }}
      />
    </>
  );
}
