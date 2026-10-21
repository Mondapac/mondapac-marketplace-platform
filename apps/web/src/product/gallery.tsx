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
  thumbs,
  certifications,
  special,
}: {
  readonly name: string;
  readonly category: string;
  readonly photos: readonly string[];
  /** Small versions of the photos for the strip, same order; the photos themselves when absent. */
  readonly thumbs?: readonly string[] | undefined;
  readonly certifications: readonly CertificationBadge[];
  readonly special: boolean;
}) {
  const t = useTranslations('product');
  const [index, setIndex] = useState(0);
  // A photo the browser cannot load (taken down since, or the image origin is down) is left out;
  // with none left the category art shows, as for a product without photos.
  const [failed, setFailed] = useState<readonly string[]>([]);
  const shots = photos.flatMap((src, i) =>
    failed.includes(src) ? [] : [{ src, thumb: thumbs?.[i] ?? src }],
  );
  const photo = shots[Math.min(index, shots.length - 1)]?.src;
  const fail = (src: string) => setFailed((list) => (list.includes(src) ? list : [...list, src]));
  return (
    <div className="gal">
      <div className={shots.length === 0 ? 'gmain nophoto' : 'gmain'}>
        {photo ? (
          // A photo is the API's public photo route (a plain image, not a server-resized one).
          <img src={photo} alt={name} decoding="async" onError={() => fail(photo)} />
        ) : (
          <CategoryArt code={category} />
        )}
        {certifications.map((badge) => (
          <CertificationSeal key={badge.type} badge={badge} />
        ))}
        {special ? <span className="badge">{t('special-price')}</span> : null}
      </div>
      {shots.length > 1 ? (
        <div className="gth" role="group" aria-label={t('photos')}>
          {shots.map((shot, i) => (
            <button
              key={shot.src}
              type="button"
              aria-label={t('photo', { index: i + 1 })}
              aria-current={shot.src === photo ? 'true' : undefined}
              onClick={() => setIndex(i)}
            >
              <img
                src={shot.thumb}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => fail(shot.src)}
              />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
