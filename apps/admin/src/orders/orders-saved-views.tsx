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
  LIST_KEY,
  payloadOf,
  problemOf,
  type SavedFilter,
  type SavedFiltersAnswer,
} from './orders-saved.ts';
import type { OrderFilters, SortId } from './orders-query.ts';

const TOAST = { id: 'orders-saved-filter' };

/** Every word of the saved-view dialogs, from the page's messages. */
function useLabels(limits: SavedFiltersAnswer['limits']): SavedViewLabels {
  const t = useTranslations('orders.saved');
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
      },
      error: (problem) =>
        t(`error.${problem}`, {
          max: problem === 'shared-limit' ? limits.shared : limits.perOwner,
        }),
    }),
    [t, limits.perOwner, limits.shared],
  );
}

/**
 * The Save filter and Manage filters dialogs of the order list, wired to the saved-filter routes.
 * The list owns the saved views it shows; this reloads them after each change.
 */
export function OrdersSavedViews({
  dialog,
  onClose,
  filters,
  sort,
  summary,
  saved,
  csrfToken,
  onSaved,
  onChanged,
}: {
  readonly dialog: 'save' | 'manage' | null;
  readonly onClose: () => void;
  readonly filters: OrderFilters;
  readonly sort: SortId;
  /** What the filter holds, in words. */
  readonly summary: string;
  readonly saved: SavedFiltersAnswer;
  readonly csrfToken: string;
  /** A new filter was saved: the list reloads and shows it. */
  readonly onSaved: (filter: SavedFilter) => void;
  /** A filter was renamed, shared or deleted: the list reloads. */
  readonly onChanged: () => void;
}) {
  const t = useTranslations('orders.saved');
  const labels = useLabels(saved.limits);
  const views: readonly SavedViewItem[] = saved.items;

  return (
    <>
      <SaveViewDialog
        open={dialog === 'save'}
        onClose={onClose}
        summary={summary}
        canShare={saved.canShare}
        labels={labels}
        idPrefix="orders"
        onSave={async (name, visibility: SavedViewVisibility) => {
          const result = await callApi<SavedFilter>(
            'POST',
            'ordering/admin/saved-filters',
            { listKey: LIST_KEY, name, visibility, payload: payloadOf(filters, sort) },
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
        idPrefix="orders"
        onRename={async (id, name, visibility) => {
          const result = await callApi<SavedFilter>(
            'PUT',
            `ordering/admin/saved-filters/${id}`,
            { name, visibility },
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
            `ordering/admin/saved-filters/${id}`,
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
      />
    </>
  );
}
