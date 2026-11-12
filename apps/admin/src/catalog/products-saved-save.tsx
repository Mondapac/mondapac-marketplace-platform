'use client';

import {
  SaveFilterDialog as SaveDialog,
  toast,
  type SavedFilterProblem,
  type SaveFilterLabels,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { callApi, type ApiFailure } from '../api/client.ts';
import { LIST_KEY, payloadOf, type SavedFilter } from './products-saved-types.ts';
import type { Query } from './products-types.ts';

/** What a refused save says, in the key of the message (one per cause). */
export function problemOf(failure: ApiFailure): SavedFilterProblem {
  if (failure.code === 'saved-filter.name-taken') return 'name-taken';
  if (failure.code === 'saved-filter.limit-reached') return 'limit';
  if (failure.code === 'saved-filter.shared-limit-reached') return 'shared-limit';
  if (failure.status === 401 || failure.status === 403) return 'denied';
  if (failure.code === 'validation.failed') {
    return failure.details?.fields?.some((field) => field.path === 'name')
      ? 'name-empty'
      : 'unavailable';
  }
  return 'unavailable';
}

/** The words of the saved-filter dialogs, from the page's messages. */
export function useSavedFilterFieldLabels(limits: {
  readonly perOwner: number;
  readonly shared: number;
}) {
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
      'acting-as': t('error.denied'),
      'not-found': t('error.unavailable'),
      unavailable: t('error.unavailable'),
    },
  } as const;
}

/**
 * The Save filter dialog (Figma "Save filter"): a name and who can use the filter, over a one-line
 * summary of what is saved. An admin whose role holds `catalog.saved-filter.share` chooses Only me
 * or Everyone; any other admin sees that the filter is saved for them only. The dialog itself is
 * the shared one; this wraps it with the admin saved-filter route and its words.
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
  /** What the filter holds, in words: the tab, the search and each condition. */
  readonly summary: string;
  readonly canShare: boolean;
  readonly limits: { readonly perOwner: number; readonly shared: number };
  readonly csrfToken: string;
  readonly onSaved: (filter: SavedFilter) => void;
}) {
  const t = useTranslations('catalog.products.saved');
  const fields = useSavedFilterFieldLabels(limits);
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
          'catalog/admin/saved-filters',
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
