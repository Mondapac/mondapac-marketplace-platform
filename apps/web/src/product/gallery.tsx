'use client';

import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { CertificationSeal } from '../certification/certification-seal.tsx';
import { CategoryArt } from '../icons/category-icon.tsx';
import type { CertificationBadge } from '../storefront/types.ts';

/**
 * The large photo with its thumbnails, the certification seal (the structured badge, never a
 * free tag) and the special price badge. A product without photos shows its category art.
 */
export function Gallery({
  name,
  category,
  photos,
  certifications,
  special,
}: {
  readonly name: string;
  readonly category: string;
  readonly photos: readonly string[];
  readonly certifications: readonly CertificationBadge[];
  readonly special: boolean;
}) {
  const t = useTranslations('product');
  const [index, setIndex] = useState(0);
  const photo = photos[index];
  return (
    <div className="gal">
      <div className="gmain">
        {photo ? (
          // Placeholder photos are local files; seller media moves to next/image with the media API.
          <img src={photo} alt={name} decoding="async" />
        ) : (
          <CategoryArt code={category} />
        )}
        {certifications.map((badge) => (
          <CertificationSeal key={badge.type} badge={badge} />
        ))}
        {special ? <span className="badge">{t('special-price')}</span> : null}
      </div>
      {photos.length > 1 ? (
        <div className="gth" role="group" aria-label={t('photos')}>
          {photos.map((src, i) => (
            <button
              key={src}
              type="button"
              aria-label={t('photo', { index: i + 1 })}
              aria-current={i === index ? 'true' : undefined}
              onClick={() => setIndex(i)}
            >
              <img src={src} alt="" loading="lazy" decoding="async" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
