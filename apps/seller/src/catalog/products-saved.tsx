'use client';

import {
  ManageFiltersDialog as ManageDialog,
  SaveFilterDialog as SaveDialog,
  toast,
  type ManageFiltersLabels,
  type SavedFilterProblem,
  type SaveFilterLabels,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { callApi, type ApiFailure } from '../api/client.ts';
import type { Query } from './products-list-types.ts';
import { LIST_KEY, payloadOf, type SavedFilter } from './products-saved-types.ts';

type Limits = { readonly perOwner: number; readonly shared: number };

/** What a refused saved-filter request says, one cause each (catalog design 9.2d). */
export function problemOf(failure: ApiFailure): SavedFilterProblem {
  if (failure.code === 'saved-filter.name-taken') return 'name-taken';
  if (failure.code === 'saved-filter.limit-reached') return 'limit';
  if (failure.code === 'saved-filter.shared-limit-reached') return 'shared-limit';
  if (failure.code === 'saved-filter.not-found' || failure.status === 404) return 'not-found';
  if (failure.code === 'access.acting-as-refused') return 'acting-as';
  if (failure.status === 401 || failure.status === 403) return 'denied';
  if (failure.code === 'validation.failed') {
    return failure.details?.fields?.some((field) => field.path === 'name')
      ? 'name-empty'
      : 'unavailable';
  }
  return 'unavailable';
}

function useFieldLabels(limits: Limits) {
  const t = useTranslations('catalog.products.saved');
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
      'acting-as': t('error.acting-as'),
      'not-found': t('error.not-found'),
      unavailable: t('error.unavailable'),
    },
  } as const;
}

/**
 * The Save filter dialog of the seller Products list: a name and who can use the filter. A member
 * whose role may share chooses Only me or Everyone (everyone in the store); any other member sees
 * that the filter is saved for them only. The dialog is the shared one; this wraps it with the
 * seller saved-filter route and its words. The CSRF token goes with the write, as for every
 * seller write.
 */
export function SaveFilterDialog({
  open,
  onClose,
  query,
  summary,
  canShare,
  limits,
  csrfToken,
  onSaved,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly query: Query;
  /** What the filter holds, in words: the tab, the search, each condition and the sort. */
  readonly summary: string;
  readonly canShare: boolean;
  readonly limits: Limits;
  readonly csrfToken: string;
  readonly onSaved: (filter: SavedFilter) => void;
}) {
  const t = useTranslations('catalog.products.saved');
  const fields = useFieldLabels(limits);
  const labels: SaveFilterLabels = { ...fields, title: t('save.title'), submit: t('save.submit') };
  return (
    <SaveDialog
      open={open}
      onClose={onClose}
      summary={summary}
      canShare={canShare}
      labels={labels}
      onSubmit={async ({ name, visibility }) => {
        const result = await callApi<SavedFilter>(
          'POST',
          'catalog/seller/saved-filters',
          { listKey: LIST_KEY, name, visibility, payload: payloadOf(query) },
          csrfToken,
        );
        if (!result.ok) return problemOf(result.failure);
        toast.success(t('toast.saved', { name: result.body.name }), {
          id: 'products-saved-filter',
        });
        onSaved(result.body);
        return null;
      }}
    />
  );
}

/**
 * The Manage filters dialog of the seller Products list: every saved filter the member can see,
 * with rename, who can use it and delete for the ones they may manage. A filter another member
 * shared, which this role cannot manage, is listed without actions. Each change is a toast, and
 * the page's tabs refresh (also when the filter was already gone).
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
  readonly limits: Limits;
  readonly csrfToken: string;
  readonly onChanged: () => void;
}) {
  const t = useTranslations('catalog.products.saved');
  const fields = useFieldLabels(limits);
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
          `catalog/seller/saved-filters/${id}`,
          input,
          csrfToken,
        );
        if (!result.ok) {
          const problem = problemOf(result.failure);
          // A filter that is gone (or no longer visible to this member) is not in the list now.
          if (problem === 'not-found') onChanged();
          return problem;
        }
        toast.success(t('toast.updated', { name: result.body.name }), {
          id: 'products-saved-filter',
        });
        onChanged();
        return null;
      }}
      onDelete={async (id) => {
        const result = await callApi<{ id: string }>(
          'DELETE',
          `catalog/seller/saved-filters/${id}`,
          undefined,
          csrfToken,
        );
        // A filter already gone is what the member wanted: say so and refresh the list.
        if (!result.ok && problemOf(result.failure) !== 'not-found')
          return problemOf(result.failure);
        const name = filters.find((filter) => filter.id === id)?.name ?? '';
        toast.success(t('toast.deleted', { name }), { id: 'products-saved-filter' });
        onChanged();
        return null;
      }}
    />
  );
}
