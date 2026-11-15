'use client';

import {
  ManageFiltersDialog as ManageDialog,
  SaveFilterDialog as SaveDialog,
  toast,
  type ManageFiltersLabels,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { callApi } from '../api/client.ts';
import { problemOf } from '../catalog/products-saved-save.tsx';
import { LIST_KEY, payloadOf, type Query, type SavedFilter } from './list-types.ts';

const BASE = 'customers/admin/saved-filters';

function useFieldLabels(limits: { readonly perOwner: number; readonly shared: number }) {
  const t = useTranslations('customers.list.saved');
  return {
    name: t('save.name'),
    who: t('save.who'),
    me: t('visibility.me'),
    everyone: t('visibility.everyone'),
    everyoneHelp: t('save.everyone-help'),
    ownOnly: t('save.own-only'),
    cancel: t('cancel'),
    errors: {
      'name-taken': t('error.name-taken'),
      'name-empty': t('error.name-empty'),
      limit: t('error.limit', { max: limits.perOwner }),
      'shared-limit': t('error.shared-limit', { max: limits.shared }),
      denied: t('error.denied'),
      'acting-as': t('error.denied'),
      'not-found': t('error.unavailable'),
      unavailable: t('error.unavailable'),
    },
  } as const;
}

/**
 * The Save filter and Manage filters dialogs of the Customers list: the shared dialogs of
 * `@mondapac/ui` over `customers/admin/saved-filters` (personal, or shared with everyone with
 * `customers.saved-filter.share`).
 */
export function CustomersSavedDialogs({
  dialog,
  onClose,
  query,
  summary,
  filters,
  canShare,
  limits,
  csrfToken,
  onSaved,
  onChanged,
}: {
  readonly dialog: 'save' | 'manage' | null;
  readonly onClose: () => void;
  readonly query: Query;
  readonly summary: string;
  readonly filters: readonly SavedFilter[];
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
  readonly csrfToken: string;
  readonly onSaved: (filter: SavedFilter) => void;
  readonly onChanged: () => void;
}) {
  const t = useTranslations('customers.list.saved');
  const fields = useFieldLabels(limits);
  const manageLabels: ManageFiltersLabels = {
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
    <>
      <SaveDialog
        open={dialog === 'save'}
        onClose={onClose}
        summary={summary}
        canShare={canShare}
        labels={{ ...fields, title: t('save.title'), submit: t('save.submit') }}
        onSubmit={async ({ name, visibility }) => {
          const result = await callApi<SavedFilter>(
            'POST',
            BASE,
            { listKey: LIST_KEY, name, visibility, payload: payloadOf(query) },
            csrfToken,
          );
          if (!result.ok) return problemOf(result.failure);
          toast.success(t('toast.saved', { name: result.body.name }), {
            id: 'customers-saved-filter',
          });
          onSaved(result.body);
          return null;
        }}
      />
      <ManageDialog
        open={dialog === 'manage'}
        onClose={onClose}
        filters={filters}
        canShare={canShare}
        labels={manageLabels}
        onUpdate={async (id, input) => {
          const result = await callApi<SavedFilter>(
            'PUT',
            `${BASE}/${encodeURIComponent(id)}`,
            input,
            csrfToken,
          );
          if (!result.ok) return problemOf(result.failure);
          toast.success(t('toast.updated', { name: result.body.name }), {
            id: 'customers-saved-filter',
          });
          onChanged();
          return null;
        }}
        onDelete={async (id) => {
          const result = await callApi<{ id: string }>(
            'DELETE',
            `${BASE}/${encodeURIComponent(id)}`,
            undefined,
            csrfToken,
          );
          if (!result.ok && result.failure.code !== 'saved-filter.not-found') {
            return problemOf(result.failure);
          }
          const name = filters.find((filter) => filter.id === id)?.name ?? '';
          toast.success(t('toast.deleted', { name }), { id: 'customers-saved-filter' });
          onChanged();
          return null;
        }}
      />
    </>
  );
}
