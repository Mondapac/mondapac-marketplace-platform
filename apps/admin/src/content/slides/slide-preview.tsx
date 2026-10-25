'use client';

import { useTranslations } from 'next-intl';
import { useId, useState } from 'react';
import type { SlideFormState } from './slide-form.ts';

const SIZES = [375, 768, 1280] as const;
type Size = (typeof SIZES)[number];

// The buyer site's slide frame per width (apps/web globals.css `.slider`): 6:5 on a phone, 5:2 on
// a tablet and 3:1 at the top of the home page on a desktop. The buyer component itself lives in
// another app (the panels never import it), so this is a static copy of its layout.
const FRAME: Record<Size, string> = {
  375: 'aspect-6/5',
  768: 'aspect-5/2',
  1280: 'aspect-3/1',
};
const WIDTH: Record<Size, string> = { 375: 'max-w-xs', 768: 'max-w-md', 1280: '' };

/**
 * A static preview of the buyer slide built from the form: text on the start side, the ready-made
 * picture on the other, never under a word (on a phone the picture is faded behind the text).
 */
export function SlidePreview({
  form,
  tone,
  compact = false,
}: {
  readonly form: SlideFormState;
  /** The saved text tone of the slide (the buyer site's `textTone`). */
  readonly tone: 'light' | 'dark';
  /** A dialog's preview: the phone frame only, without the size switch or the note. */
  readonly compact?: boolean;
}) {
  const titleId = useId();
  const t = useTranslations('content.slides.preview');
  const images = useTranslations('content.slides.editor.image-key');
  const [chosen, setSize] = useState<Size>(1280);
  const size: Size = compact ? 375 : chosen;
  const phone = size === 375;
  const title = form.title.trim();
  const body = form.body.trim();
  const showButton = form.ctaLabel.trim() !== '' && form.linkType !== '';
  return (
    <aside
      aria-labelledby={titleId}
      className="flex min-w-0 flex-col gap-3 rounded-lg border border-line bg-surface p-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={titleId} className="text-base font-semibold">
          {t('title')}
        </h2>
        {compact ? null : (
          <div role="group" aria-label={t('size')} className="flex gap-2">
            {SIZES.map((width) => (
              <button
                key={width}
                type="button"
                aria-pressed={size === width}
                aria-label={t('size-option', { width })}
                onClick={() => setSize(width)}
                className={`inline-flex h-(--mp-size-control-sm) min-w-12 items-center justify-center rounded-md border px-3 text-sm focus-visible:outline-2 focus-visible:outline-focus ${size === width ? 'border-accent bg-selected font-medium text-link' : 'border-line-control bg-surface text-fg hover:bg-muted'}`}
              >
                {width}
              </button>
            ))}
          </div>
        )}
      </div>
      <div
        role="img"
        aria-label={t('frame', { width: size })}
        className={`relative mx-auto grid w-full overflow-hidden rounded-lg border border-line ${WIDTH[size]} ${tone === 'light' ? 'bg-accent text-on-accent' : 'bg-muted text-fg'}`}
      >
        <span aria-hidden="true" className={`col-start-1 row-start-1 ${FRAME[size]}`} />
        {form.imageRef === '' ? null : (
          <span
            className={`absolute inset-y-0 end-0 flex items-center justify-center border-s border-current text-xs ${phone ? 'start-0 opacity-30' : 'w-2/5 opacity-70'}`}
          >
            {t('image', {
              name: images.has(form.imageRef) ? images(form.imageRef) : form.imageRef,
            })}
          </span>
        )}
        <div
          className={`relative z-10 col-start-1 row-start-1 flex flex-col items-start justify-center gap-2 p-4 sm:px-6 ${phone ? 'w-full' : 'w-3/5'}`}
        >
          {form.sponsored ? (
            <span className="text-xs font-medium uppercase">{t('sponsored')}</span>
          ) : null}
          <p
            dir="auto"
            className={`line-clamp-3 shrink-0 break-words text-lg font-semibold ${title === '' ? 'opacity-70' : ''}`}
          >
            {title === '' ? t('headline') : title}
          </p>
          {body === '' ? null : (
            <p dir="auto" className="line-clamp-3 shrink-0 break-words text-sm">
              {body}
            </p>
          )}
          {showButton ? (
            <span
              dir="auto"
              className="inline-flex min-h-8 max-w-full shrink-0 items-center rounded-md border border-current px-3 text-sm font-medium"
            >
              <span className="break-words">{form.ctaLabel.trim()}</span>
            </span>
          ) : null}
        </div>
      </div>
      {compact ? null : <p className="text-sm text-fg-muted">{t('note')}</p>}
    </aside>
  );
}
