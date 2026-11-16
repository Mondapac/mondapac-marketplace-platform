import type { SettingsDrawerLabels } from '@mondapac/ui';
import { useTranslations } from 'next-intl';

/** The shared words of a settings drawer; the page names the exact verb of the primary button. */
export function useDrawerLabels(submit: string): SettingsDrawerLabels {
  const t = useTranslations('settings.drawer');
  return {
    close: t('close'),
    cancel: t('cancel'),
    submit,
    discardTitle: t('discard-title'),
    discardMessage: t('discard-message'),
    keepEditing: t('keep'),
    discard: t('discard'),
  };
}
