'use client';

import { Banner, SaveBar, SettingsPage, type LastChangedValue } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { useChangeHistory } from '../settings/last-changed.tsx';
import { useSettingsChrome } from '../settings/settings-chrome.ts';
import { useAbout } from './about-card.tsx';
import { ImageCard } from './image-card.tsx';
import type { StoreImageRef, StoreProfileView } from './types.ts';

/**
 * The seller's Store profile settings: the About text, the logo and the banner. Every save is
 * public at once (no review). The About text is the page's one form, with the save bar; it keeps
 * the version it loaded, so a text save never overwrites a newer text it has not shown. A picture
 * is its own action (choose, replace, remove), saved the moment it is chosen: the logo and banner
 * are kept here, since a picture save answers with the whole profile but changes only that picture.
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
  const about = useAbout({ initial, csrfToken });
  const [logo, setLogo] = useState<StoreImageRef | null>(initial.logo);
  const [banner, setBanner] = useState<StoreImageRef | null>(initial.banner);
  // A picture save answers with the whole profile, so its change is the newest the page knows of.
  const [pictureChange, setPictureChange] = useState<LastChangedValue | null>(null);
  const textChange = about.lastChanged;
  const newest =
    pictureChange !== null &&
    (textChange === null || Date.parse(pictureChange.at) >= Date.parse(textChange.at))
      ? pictureChange
      : textChange;
  const changeHistory = useChangeHistory(newest, 'sellers/store-profile/history');
  const onPicture = (
    set: (image: StoreImageRef | null) => void,
    image: StoreImageRef | null,
    change: LastChangedValue | null,
  ) => {
    set(image);
    if (change !== null) setPictureChange(change);
  };

  const banners = [
    canEdit ? null : (
      <Banner key="view-only" tone="info">
        {t('store-profile.view-only')}
      </Banner>
    ),
    ...about.banners,
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
      onSubmit={canEdit ? () => void about.save() : undefined}
      dirty={canEdit && about.dirty}
      leave={chrome.leave}
      saveBar={
        canEdit ? (
          <SaveBar
            {...chrome.saveBar({
              count: about.count,
              errorCount: about.errorCount,
              saving: about.saving,
              onDiscard: about.discard,
            })}
          />
        ) : null
      }
    >
      {about.section(canEdit)}
      <ImageCard
        kind="logo"
        image={logo}
        onImage={(image, change) => onPicture(setLogo, image, change)}
        csrfToken={csrfToken}
        canEdit={canEdit}
      />
      <ImageCard
        kind="banner"
        image={banner}
        onImage={(image, change) => onPicture(setBanner, image, change)}
        csrfToken={csrfToken}
        canEdit={canEdit}
      />
    </SettingsPage>
  );
}
