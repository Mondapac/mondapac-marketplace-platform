'use client';

import {
  relativeTime,
  SettingsHistoryDrawer,
  useSettingsHistory,
  whoKind,
  type LastChangedValue,
  type SettingsHistoryItem,
  type SettingsPageProps,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, type ReactNode } from 'react';
import { callApi } from '../api/client.ts';

/** One row of a settings history as the API answers it (names and field names only). */
interface ChangeRow extends LastChangedValue {
  readonly id: string;
  readonly fields: readonly string[];
}

interface ChangePage {
  readonly items: readonly ChangeRow[];
  readonly next: string | null;
}

const PAGE = 20;

const isValue = (value: unknown): value is LastChangedValue => {
  if (typeof value !== 'object' || value === null) return false;
  const row = value as Partial<LastChangedValue>;
  return (
    typeof row.at === 'string' &&
    (row.byDisplayName === null || typeof row.byDisplayName === 'string') &&
    (row.byKind === 'member' || row.byKind === 'platform' || row.byKind === 'system')
  );
};

/** "audiencePercent" as "Audience percent": a field name from the API, worded for a reader. */
export function humanField(name: string): string {
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * The "Last changed by Sara K. · 2 days ago · View history" line of a settings page and its
 * history drawer (panel settings T3a). `lastChanged` is what the page's read returned (null:
 * never changed, so no line); `historyPath` is the page's history route. The drawer asks the
 * route when it opens, a page at a time. Names come from the API as display names only.
 */
export function useChangeHistory(
  lastChanged: LastChangedValue | null | undefined,
  historyPath: string,
): { readonly line: SettingsPageProps['lastChanged']; readonly drawer: ReactNode } {
  const t = useTranslations('settings');
  const locale = useLocale();

  const load = useCallback(
    async (after: string | null) => {
      const query = new URLSearchParams({ limit: String(PAGE) });
      if (after !== null) query.set('after', after);
      const result = await callApi<ChangePage>('GET', `${historyPath}?${query.toString()}`);
      if (!result.ok) {
        if (result.failure.status === 401) window.location.assign('/session-ended');
        return null;
      }
      const body: unknown = result.body;
      const rows = (body as Partial<ChangePage> | null)?.items;
      const valid =
        Array.isArray(rows) &&
        rows.every(
          (row: unknown) =>
            isValue(row) &&
            typeof (row as { id?: unknown }).id === 'string' &&
            Array.isArray((row as { fields?: unknown }).fields),
        );
      if (!valid) return null;
      return body as ChangePage;
    },
    [historyPath],
  );
  const history = useSettingsHistory(load);

  const whoOf = (value: LastChangedValue): string => {
    const kind = whoKind(value);
    if (kind === 'named') return value.byDisplayName ?? '';
    return kind === 'platform' ? t('history.who-platform') : t('history.who-unnamed');
  };
  const items: SettingsHistoryItem[] = history.rows.map((row) => ({
    id: row.id,
    who: whoOf(row),
    when: relativeTime(row.at, locale),
    dateTime: row.at,
    what:
      row.fields.length === 0
        ? t('history.saved')
        : t('history.changed', { fields: row.fields.map(humanField).join(', ') }),
  }));

  let line: SettingsPageProps['lastChanged'];
  if (lastChanged !== null && lastChanged !== undefined && isValue(lastChanged)) {
    const when = relativeTime(lastChanged.at, locale);
    const kind = whoKind(lastChanged);
    const text =
      kind === 'named'
        ? t('last-changed.named', { name: lastChanged.byDisplayName ?? '', when })
        : kind === 'platform'
          ? t('last-changed.platform', { when })
          : t('last-changed.unnamed', { when });
    line = {
      text,
      dateTime: lastChanged.at,
      historyLabel: t('last-changed.view-history'),
      onHistory: history.show,
      historyOpen: history.open,
    };
  }

  const drawer = (
    <SettingsHistoryDrawer
      open={history.open}
      onClose={history.close}
      onLoadMore={() => void history.more()}
      onRetry={() => void history.retry()}
      state={
        history.phase === 'loading'
          ? { kind: 'loading' }
          : history.phase === 'error'
            ? { kind: 'error' }
            : {
                kind: 'ready',
                items,
                hasMore: history.hasMore,
                loadingMore: history.loadingMore,
                moreFailed: history.moreFailed,
              }
      }
      labels={{
        title: t('history.title'),
        close: t('history.close'),
        loading: t('history.loading'),
        emptyTitle: t('history.empty-title'),
        emptyBody: t('history.empty-body'),
        error: t('history.error'),
        retry: t('history.retry'),
        loadMore: t('history.load-more'),
        moreFailed: t('history.more-failed'),
      }}
    />
  );
  return { line, drawer };
}

/**
 * "Sara K. saved these settings 1 minute ago": the title of a "someone saved first" banner from
 * the `lastChanged` of the settings read again after the conflict. Null where no one can be
 * named (a former member, the system, a read that did not carry it): the page keeps its generic
 * title.
 */
export function useWinnerTitle(): (
  winner: LastChangedValue | null | undefined,
  subject?: 'settings' | 'store-profile',
) => string | null {
  const t = useTranslations('settings.conflict');
  const locale = useLocale();
  return (winner, subject = 'settings') => {
    if (winner === null || winner === undefined || !isValue(winner)) return null;
    const when = relativeTime(winner.at, locale);
    const what = t(`subject-${subject}`);
    const kind = whoKind(winner);
    if (kind === 'named') {
      return t('saved-by-named', { name: winner.byDisplayName ?? '', subject: what, when });
    }
    return kind === 'platform' ? t('saved-by-platform', { subject: what, when }) : null;
  };
}
