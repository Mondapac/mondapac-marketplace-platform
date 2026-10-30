import type { LeaveLabels, SaveBarProps } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/**
 * The words every settings page shares: the "Leave without saving?" guard and the labels of the
 * one save bar. A page passes its own counts and callbacks; the wording stays in one place.
 */
export function useSettingsChrome(): {
  readonly leave: LeaveLabels;
  readonly saveBar: (options: {
    readonly count: number;
    readonly errorCount?: number;
    readonly saving: boolean;
    readonly onDiscard: () => void;
    /** Replaces "Save changes", for a page whose one action has another name ("Create role"). */
    readonly saveLabel?: string;
  }) => SaveBarProps;
} {
  const t = useTranslations();
  return {
    leave: {
      title: t('settings.leave.title'),
      message: t('settings.leave.message'),
      stay: t('settings.leave.stay'),
      leave: t('settings.leave.leave'),
    },
    saveBar: ({ count, errorCount = 0, saving, onDiscard, saveLabel }) => ({
      count,
      summary: t('settings.bar.summary', { count }),
      errorCount,
      errorsSummary: t('settings.bar.errors', { count: errorCount }),
      saving,
      labels: {
        region: t('settings.bar.region'),
        discard: t('settings.bar.discard'),
        save: saveLabel ?? t('settings.bar.save'),
        saving: t('settings.bar.saving'),
      },
      onDiscard,
    }),
  };
}
