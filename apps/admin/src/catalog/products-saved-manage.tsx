'use client';

import { ManageFiltersDialog as ManageDialog, toast, type ManageFiltersLabels } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { callApi } from '../api/client.ts';
import { problemOf, useSavedFilterFieldLabels } from './products-saved-save.tsx';
import type { SavedFilter } from './products-saved-types.ts';

/**
 * The Manage filters dialog (Figma "Manage filters"): every saved view the admin can see, with
 * rename, who can use it and delete for the ones they may manage. Reordering is not offered (the
 * design shows none). Each change is a toast, and the page's tabs refresh. The dialog itself is the
 * shared one; this wraps it with the admin saved-filter routes and its words.
 */
export function ManageFiltersDialog({
  open,
  onClose,
  filters,
  canShare,
  limits,
  csrfToken,
  onChanged,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly filters: readonly SavedFilter[];
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
  readonly csrfToken: string;
  readonly onChanged: () => void;
}) {
  const t = useTranslations('catalog.products.saved');
  const fields = useSavedFilterFieldLabels(limits);
  const labels: ManageFiltersLabels = {
    ...fields,
    title: t('manage.title'),
    close: t('manage.close'),
    edit: t('manage.edit'),
    editNamed: (name) => t('manage.edit-named', { name }),
    delete: t('manage.delete'),
    deleteNamed: (name) => t('manage.delete-named', { name }),
    deleteConfirm: t('manage.delete-confirm'),
    deleteOwn: (name) => t('manage.delete-own', { name }),
    deleteShared: (name) => t('manage.delete-shared', { name }),
    save: t('manage.save'),
    sharedByOther: t('manage.shared-by-other'),
    empty: t('manage.empty'),
    emptyHelp: t('manage.empty-help'),
    helpShare: t('manage.help-share'),
    helpOwn: t('manage.help-own'),
  };
  return (
    <ManageDialog
      open={open}
      onClose={onClose}
      filters={filters}
      canShare={canShare}
      labels={labels}
      onUpdate={async (id, input) => {
        const result = await callApi<SavedFilter>(
          'PUT',
          `catalog/admin/saved-filters/${id}`,
          input,
          csrfToken,
        );
        if (!result.ok) return problemOf(result.failure);
        toast.success(t('toast.updated', { name: result.body.name }), {
          id: 'products-saved-filter',
        });
        onChanged();
        return null;
      }}
      onDelete={async (id) => {
        const result = await callApi<{ id: string }>(
          'DELETE',
          `catalog/admin/saved-filters/${id}`,
          undefined,
          csrfToken,
        );
        // A filter already gone is what the admin wanted: say so and refresh the list.
        if (!result.ok && result.failure.code !== 'saved-filter.not-found') {
          return problemOf(result.failure);
        }
        const name = filters.find((filter) => filter.id === id)?.name ?? '';
        toast.success(t('toast.deleted', { name }), { id: 'products-saved-filter' });
        onChanged();
        return null;
      }}
    />
  );
}
