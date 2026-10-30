'use client';

import { Banner, Button, Card, FileButton, ImageSlot, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useLayoutEffect, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { preparePhoto } from '../catalog/photo-prepare.ts';
import { imageProblemOf, type ImageProblem } from './errors.ts';
import {
  storeImageUrl,
  type ImageKind,
  type StoreImageRef,
  type StoreProfileView,
} from './types.ts';

type Status = 'idle' | 'uploading' | 'removing';
type Preview = 'phone' | 'desktop';

/** The classes of the banner boxes buyers see (packages/ui styles.css): a phone strip and a wide one. */
const PREVIEW_ASPECT: Record<Preview, string> = {
  phone: 'aspect-banner-phone',
  desktop: 'aspect-banner-desktop',
};

/**
 * The logo or the banner: the picture as buyers see it, choose or replace (shrunk in the browser
 * first), and remove with a confirmation. The picture is public as soon as it is saved. The banner
 * preview is cropped the way the buyer site crops it, on a phone or on a wide screen.
 */
export function ImageCard({
  kind,
  image,
  onImage,
  csrfToken,
  canEdit,
}: {
  readonly kind: ImageKind;
  readonly image: StoreImageRef | null;
  readonly onImage: (image: StoreImageRef | null) => void;
  readonly csrfToken: string;
  readonly canEdit: boolean;
}) {
  const t = useTranslations();
  const input = useRef<HTMLInputElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const busy = useRef(false);
  // Where focus goes after the next render: the confirm button, back to Remove, or the picker.
  const focusNext = useRef<'confirm' | 'remove' | 'choose' | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [problem, setProblem] = useState<ImageProblem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<Preview>('phone');
  const working = status === 'uploading' || status === 'removing';
  const path = `sellers/store-profile/${kind}`;

  // A layout effect, so focus moves in the same commit as the change it follows. A passive effect
  // ran a moment later, after the toast ("Logo removed.") was already on screen.
  useLayoutEffect(() => {
    const target = focusNext.current;
    if (target === null) return;
    focusNext.current = null;
    const element =
      target === 'confirm'
        ? confirmButton.current
        : target === 'remove'
          ? removeButton.current
          : input.current;
    element?.focus();
  });

  function failed(problemOf: ImageProblem) {
    setStatus('idle');
    setProblem(problemOf);
  }

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined || busy.current) return;
    busy.current = true;
    setStatus('uploading');
    setProblem(null);
    setConfirming(false);
    const prepared = await preparePhoto(file);
    // The picker was disabled while the picture went up: focus returns to it when this ends.
    focusNext.current = 'choose';
    if (prepared.kind === 'refused') {
      failed({ key: prepared.reason === 'too-large' ? 'too-large' : 'unreadable' });
    } else {
      const result = await callApi<StoreProfileView>(
        'PUT',
        path,
        { data: prepared.data },
        csrfToken,
      );
      if (result.ok) {
        onImage(result.body[kind]);
        setStatus('idle');
        toast.success(t(`store-profile.${kind}.saved`));
      } else if (result.failure.status === 401) {
        window.location.assign('/session-ended');
      } else {
        failed(imageProblemOf(result.failure, kind));
      }
    }
    busy.current = false;
    if (input.current !== null) input.current.value = '';
  }

  async function remove() {
    if (busy.current) return;
    busy.current = true;
    setConfirming(false);
    setStatus('removing');
    setProblem(null);
    const result = await callApi<StoreProfileView>('DELETE', path, undefined, csrfToken);
    busy.current = false;
    if (result.ok) {
      onImage(result.body[kind]);
      // The Remove button is gone with the picture: focus moves to the way to choose another.
      focusNext.current = 'choose';
      setStatus('idle');
      toast.success(t(`store-profile.${kind}.removed`));
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else {
      focusNext.current = 'remove';
      failed(imageProblemOf(result.failure, kind));
    }
  }

  function askToRemove() {
    focusNext.current = 'confirm';
    setConfirming(true);
  }

  function cancelRemove() {
    focusNext.current = 'remove';
    setConfirming(false);
  }

  const announced =
    status === 'uploading'
      ? t('store-profile.image.uploading')
      : status === 'removing'
        ? t('store-profile.image.removing')
        : null;

  return (
    <Card title={t(`store-profile.${kind}.title`)}>
      <p className="text-sm text-fg-muted">{t(`store-profile.${kind}.help`)}</p>
      {problem === null ? null : (
        <Banner tone="critical">
          {t(`store-profile.image.error.${problem.key}`, {
            seconds: problem.retryAfterSeconds ?? 60,
          })}
        </Banner>
      )}
      {image === null ? (
        <ImageSlot shape={kind === 'logo' ? 'square' : 'banner'}>
          {t(`store-profile.${kind}.none`)}
        </ImageSlot>
      ) : kind === 'logo' ? (
        <img
          src={storeImageUrl(image.id, 'small')}
          alt={t('store-profile.logo.alt')}
          width={96}
          height={96}
          className={`size-24 rounded-md border border-line bg-surface object-contain ${
            working ? 'opacity-50' : ''
          }`}
        />
      ) : (
        <div className="flex flex-col gap-2">
          <div
            role="group"
            aria-label={t('store-profile.banner.preview.label')}
            className="flex items-center gap-2"
          >
            <span className="text-sm text-fg-muted">{t('store-profile.banner.preview.label')}</span>
            {(['phone', 'desktop'] as const).map((choice) => (
              <Button
                key={choice}
                variant={preview === choice ? 'primary' : 'secondary'}
                aria-pressed={preview === choice}
                onClick={() => setPreview(choice)}
              >
                {t(`store-profile.banner.preview.${choice}`)}
              </Button>
            ))}
          </div>
          <div
            className={`relative w-full overflow-hidden rounded-md border border-line bg-muted ${PREVIEW_ASPECT[preview]} ${
              working ? 'opacity-50' : ''
            }`}
          >
            <img
              src={storeImageUrl(image.id, 'large')}
              alt={t('store-profile.banner.alt')}
              width={image.width}
              height={image.height}
              className="size-full object-cover"
            />
            {/* Where the buyer site puts its Share button, in both shapes. */}
            <span
              aria-hidden="true"
              className="absolute end-2 top-2 h-6 w-16 rounded-full border-2 border-dashed border-line-control bg-surface/60"
            />
            {preview === 'desktop' ? (
              <span
                aria-hidden="true"
                className="absolute bottom-0 start-4 aspect-square h-2/5 rounded-md border-2 border-dashed border-line-control bg-surface/60"
              />
            ) : null}
          </div>
          {preview === 'desktop' ? (
            <p className="text-sm text-fg-muted">{t('store-profile.banner.preview.logo-note')}</p>
          ) : null}
        </div>
      )}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <FileButton
            inputRef={input}
            accept="image/jpeg,image/png,image/webp"
            disabled={working}
            onFiles={(files) => void upload(files)}
          >
            {image === null ? t('store-profile.image.choose') : t('store-profile.image.replace')}
          </FileButton>
          {image === null ? null : confirming ? (
            <>
              <p className="basis-full text-sm">{t(`store-profile.${kind}.confirm`)}</p>
              <Button
                ref={confirmButton}
                variant="destructive"
                onClick={() => void remove()}
                disabled={working}
              >
                {t('store-profile.image.remove-yes')}
              </Button>
              <Button variant="link" onClick={cancelRemove}>
                {t('store-profile.image.cancel')}
              </Button>
            </>
          ) : (
            <Button
              ref={removeButton}
              variant="destructive"
              onClick={askToRemove}
              disabled={working}
              loading={status === 'removing'}
            >
              {status === 'removing'
                ? t('store-profile.image.removing')
                : t('store-profile.image.remove')}
            </Button>
          )}
          <span className="text-sm text-fg-muted">{t('store-profile.image.formats')}</span>
        </div>
      ) : null}
      {/* Always in the page, so a screen reader hears the text when it is put in. */}
      <p role="status" className="text-sm text-fg-muted empty:sr-only">
        {announced}
      </p>
    </Card>
  );
}
