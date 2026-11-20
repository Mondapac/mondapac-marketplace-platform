'use client';

import { Button, ImageSlot } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { mediaUrl } from '../types.ts';
import { MediaPickerDialog } from './media-picker.tsx';

/**
 * A picture slot with Choose / Replace / Remove, shared by the cover card and the image block.
 * `imageId` is empty when nothing is chosen. The alt text is the caller's own field. `error` is the
 * reason a save was refused (an id the library does not know).
 */
export function ImageChooser({
  imageId,
  onChange,
  disabled,
  canUpload,
  csrfToken,
  error,
  name,
  altEmpty,
  focusAlt,
}: {
  readonly imageId: string;
  readonly onChange: (id: string) => void;
  readonly disabled: boolean;
  readonly canUpload: boolean;
  readonly csrfToken: string;
  readonly error?: string | undefined;
  /** What the picture is for ("cover image", "block 2"), so each button names its slot. */
  readonly name: string;
  /** The alt text next to this picture is empty: after an upload, focus goes to it. */
  readonly altEmpty: boolean;
  readonly focusAlt: () => void;
}) {
  const t = useTranslations('blog.media');
  const [open, setOpen] = useState(false);
  const [broken, setBroken] = useState<string | null>(null);
  const choose = useRef<HTMLButtonElement>(null);
  const has = imageId !== '';
  // After an upload the dialog closes and gives focus back to the opener on the next task; this
  // effect runs after that is scheduled, so its own task wins: the required next step (the alt
  // text) when it is empty, else the Replace button.
  const [after, setAfter] = useState<'alt' | 'replace' | null>(null);
  useEffect(() => {
    if (open || after === null) return;
    const timer = setTimeout(() => {
      if (after === 'alt') focusAlt();
      else choose.current?.focus();
      setAfter(null);
    }, 0);
    return () => clearTimeout(timer);
  }, [open, after, focusAlt]);

  return (
    <div className="flex flex-col gap-2">
      {has ? (
        broken === imageId ? (
          <ImageSlot>{t('preview-missing')}</ImageSlot>
        ) : (
          <img
            key={imageId}
            src={mediaUrl(imageId, 'thumb')}
            alt=""
            className="max-h-48 w-full rounded-md border border-line bg-muted object-contain"
            onError={() => setBroken(imageId)}
          />
        )
      ) : (
        <ImageSlot>{t('none')}</ImageSlot>
      )}
      {has ? <p className="sr-only">{t('chosen', { name })}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button
          ref={choose}
          variant="secondary"
          disabled={disabled}
          aria-label={t(has ? 'replace-for' : 'choose-for', { name })}
          onClick={() => setOpen(true)}
        >
          {t(has ? 'replace' : 'choose-image')}
        </Button>
        {has ? (
          <Button
            variant="secondary"
            disabled={disabled}
            aria-label={t('remove-for', { name })}
            onClick={() => {
              onChange('');
              // The Remove button goes away; focus stays on a button of the same slot.
              choose.current?.focus();
            }}
          >
            {t('remove')}
          </Button>
        ) : null}
      </div>
      {error === undefined ? null : (
        <p role="alert" className="text-sm text-critical-fg">
          {error}
        </p>
      )}
      <MediaPickerDialog
        open={open}
        onClose={() => setOpen(false)}
        onPick={(id, uploaded) => {
          onChange(id);
          if (uploaded) setAfter(altEmpty ? 'alt' : 'replace');
        }}
        currentId={imageId}
        canUpload={canUpload}
        csrfToken={csrfToken}
      />
    </div>
  );
}
