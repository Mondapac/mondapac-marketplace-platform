'use client';

import { Banner, SaveBar, SettingsPage } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useSettingsChrome } from '../settings/settings-chrome.ts';
import type { StoreProfileView } from './types.ts';
import { useStoreProfile } from './use-store-profile.tsx';

/**
 * The seller's Store profile settings: the About text, the logo and the banner. Every save is
 * public at once (no review). They are the page's one form, with the one save bar: a picture
 * chosen or removed is staged with a preview and saved with the text, in one versioned save, and
 * Discard puts everything back. The form keeps the version it loaded, so a save never overwrites
 * a newer profile it has not shown.
 */
export function StoreProfile({
  initial,
  csrfToken,
  canEdit,
}: {
  readonly initial: StoreProfileView;
  readonly csrfToken: string;
  readonly canEdit: boolean;
}) {
  const t = useTranslations();
  const chrome = useSettingsChrome();
  const profile = useStoreProfile({ initial, csrfToken });

  const banners = [
    canEdit ? null : (
      <Banner key="view-only" tone="info">
        {t('store-profile.view-only')}
      </Banner>
    ),
    ...profile.banners,
  ].filter((node) => node !== null);

  return (
    <SettingsPage
      title={t('store-profile.title')}
      description={t('store-profile.intro')}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
      onSubmit={canEdit ? () => void profile.save() : undefined}
      dirty={canEdit && profile.dirty}
      leave={chrome.leave}
      saveBar={
        canEdit ? (
          <SaveBar
            {...chrome.saveBar({
              count: profile.count,
              errorCount: profile.errorCount,
              saving: profile.saving,
              onDiscard: profile.discard,
            })}
          />
        ) : null
      }
    >
      {profile.about(canEdit)}
      {profile.pictures(canEdit)}
    </SettingsPage>
  );
}
