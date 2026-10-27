'use client';

import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { CertificationSeal } from '../certification/certification-seal.tsx';
import { checkLoaded } from '../icons/check-loaded.ts';
import { CategoryArt } from '../icons/category-icon.tsx';
import { under } from '../shell/breakpoints.ts';
import type { CertificationBadge } from '../storefront/types.ts';

/**
 * The large photo with its thumbnails, the certification seal (the structured badge, never a
 * free tag) and the special price badge. A product without photos shows its category art.
 * The photos sit in a row that snaps (swipe on a phone); a "1/5" count, announced politely, tells
 * where the buyer is. The thumbnails scroll the row, and the row's position picks the thumbnail.
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
  const current = Math.min(index, Math.max(0, shots.length - 1));
  const track = useRef<HTMLDivElement>(null);
  // Set while a thumbnail scrolls the row, so the scroll it causes does not pick another photo.
  const aiming = useRef<number | null>(null);
  useEffect(() => {
    const element = track.current;
    if (!element || shots.length < 2) return;
    const onScroll = () => {
      const width = element.clientWidth;
      if (width === 0) return;
      const at = Math.min(shots.length - 1, Math.round(Math.abs(element.scrollLeft) / width));
      if (aiming.current !== null) {
        if (at !== aiming.current) return;
        aiming.current = null;
      }
      setIndex(at);
    };
    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [shots.length]);
  const show = (i: number) => {
    setIndex(i);
    const element = track.current;
    if (!element || typeof element.scrollTo !== 'function') return;
    aiming.current = i;
    const sign = getComputedStyle(element).direction === 'rtl' ? -1 : 1;
    const reduce =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    element.scrollTo({
      left: sign * i * element.clientWidth,
      behavior: reduce ? 'auto' : 'smooth',
    });
  };
  // Only a phone swipes the row, so only a phone needs it in the tab order.
  const [phone, setPhone] = useState(false);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(under('tablet'));
    const update = () => setPhone(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);
  const fail = (src: string) => setFailed((list) => (list.includes(src) ? list : [...list, src]));
  return (
    <div className="gal">
      <div
        className={
          photos.length === 0 ? 'gmain nophoto' : shots.length === 0 ? 'gmain broken' : 'gmain'
        }
      >
        {shots.length > 0 ? (
          <div
            className="gtrack"
            ref={track}
            role="group"
            aria-label={t('photo-gallery')}
            tabIndex={phone ? 0 : undefined}
          >
            {shots.map((shot, i) => (
              // A photo is the API's public photo route (a plain image, not a server-resized one).
              <div key={shot.src} className="gslide">
                <img
                  src={shot.src}
                  alt={
                    shots.length > 1
                      ? t('photo-alt', { name, index: i + 1, total: shots.length })
                      : name
                  }
                  width={800}
                  height={800}
                  decoding="async"
                  loading={i === 0 ? undefined : 'lazy'}
                  ref={(el) => checkLoaded(el, () => fail(shot.src))}
                  onError={() => fail(shot.src)}
                />
              </div>
            ))}
          </div>
        ) : (
          <CategoryArt code={category} />
        )}
        {certifications.map((badge) => (
          <CertificationSeal key={badge.type} badge={badge} />
        ))}
        {special ? <span className="badge">{t('special-price')}</span> : null}
        {shots.length > 1 ? (
          <p className="gcount num" aria-live="polite" aria-atomic="true">
            <span aria-hidden="true">
              {t('photo-count', { index: current + 1, total: shots.length })}
            </span>
            <span className="sr-only">
              {t('photo-of', { index: current + 1, total: shots.length })}
            </span>
          </p>
        ) : null}
      </div>
      {shots.length > 1 ? (
        <div className="gth" role="group" aria-label={t('photos')}>
          {shots.map((shot, i) => (
            <button
              key={shot.src}
              type="button"
              aria-label={t('photo', { index: i + 1 })}
              aria-current={i === current ? 'true' : undefined}
              onClick={() => show(i)}
            >
              <img
                src={shot.thumb}
                alt=""
                width={64}
                height={64}
                ref={(el) => checkLoaded(el, () => fail(shot.src))}
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
