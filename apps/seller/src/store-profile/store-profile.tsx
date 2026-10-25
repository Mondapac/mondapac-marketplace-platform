'use client';

import { Banner } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { AboutCard } from './about-card.tsx';
import { ImageCard } from './image-card.tsx';
import type { StoreImageRef, StoreProfileView } from './types.ts';

/**
 * The seller's Store profile settings: the About text, the logo and the banner. Every save is
 * public at once (no review). The logo and banner are kept here, since a picture save answers
 * with the whole profile but changes only that picture; the About card keeps the version it
 * loaded, so a text save never overwrites a newer text it has not shown.
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
  const [logo, setLogo] = useState<StoreImageRef | null>(initial.logo);
  const [banner, setBanner] = useState<StoreImageRef | null>(initial.banner);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('store-profile.intro')}</p>
      {canEdit ? null : <Banner tone="info">{t('store-profile.view-only')}</Banner>}
      <AboutCard initial={initial} csrfToken={csrfToken} canEdit={canEdit} />
      <ImageCard
        kind="logo"
        image={logo}
        onImage={setLogo}
        csrfToken={csrfToken}
        canEdit={canEdit}
      />
      <ImageCard
        kind="banner"
        image={banner}
        onImage={setBanner}
        csrfToken={csrfToken}
        canEdit={canEdit}
      />
    </div>
  );
}
