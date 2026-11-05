'use client';

import { SaveBar, SettingsPage, SettingsViewOnlyBanner } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useChangeHistory } from '../settings/last-changed.tsx';
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
  claimTerms = [],
}: {
  readonly initial: StoreProfileView;
  readonly csrfToken: string;
  readonly canEdit: boolean;
  /** The Market's certification claim terms, from the API, for the live About warning. */
  readonly claimTerms?: readonly string[];
}) {
  const t = useTranslations();
  const chrome = useSettingsChrome();
  const profile = useStoreProfile({ initial, csrfToken, claimTerms });
  // One save carries the text and the pictures, so the form's last change is the page's.
  const changeHistory = useChangeHistory(profile.lastChanged, 'sellers/store-profile/history');

  const banners = [
    canEdit ? null : (
      <SettingsViewOnlyBanner key="view-only" title={t('settings.view-only.title')}>
        {t('store-profile.view-only')}
      </SettingsViewOnlyBanner>
    ),
    ...profile.banners,
  ].filter((node) => node !== null);

  return (
    <SettingsPage
      title={t('store-profile.title')}
      description={t('store-profile.intro')}
      lastChanged={changeHistory.line}
      overlay={changeHistory.drawer}
      banner={
        banners.length === 0 ? undefined : <div className="flex flex-col gap-3">{banners}</div>
      }
      onSubmit={canEdit ? () => void profile.save() : undefined}
      dirty={canEdit && profile.dirty}
      dirtyCount={profile.count}
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
