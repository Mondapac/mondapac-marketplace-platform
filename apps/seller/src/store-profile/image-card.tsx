'use client';

import { Banner, Button, Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useId, useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { preparePhoto } from '../catalog/photo-prepare.ts';
import { imageProblemOf, type ImageProblem } from './errors.ts';
import {
  storeImageUrl,
  type ImageKind,
  type StoreImageRef,
  type StoreProfileView,
} from './types.ts';

type Status = 'idle' | 'uploading' | 'removing' | 'saved' | 'removed';

/**
 * The logo or the banner: the picture as buyers see it, choose or replace (shrunk in the browser
 * first), and remove with a confirmation. The picture is public as soon as it is saved.
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
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  const [status, setStatus] = useState<Status>('idle');
  const [problem, setProblem] = useState<ImageProblem | null>(null);
  const [confirming, setConfirming] = useState(false);
  const working = status === 'uploading' || status === 'removing';
  const path = `sellers/store-profile/${kind}`;

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
        setStatus('saved');
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
      setStatus('removed');
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else {
      failed(imageProblemOf(result.failure, kind));
    }
  }

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
        <p
          className={`rounded-md border border-dashed border-line p-4 text-sm text-fg-muted ${
            kind === 'banner' ? 'aspect-[4/1] content-center' : ''
          }`}
        >
          {t(`store-profile.${kind}.none`)}
        </p>
      ) : kind === 'logo' ? (
        <img
          src={storeImageUrl(image.id, 'small')}
          alt={t('store-profile.logo.alt')}
          width={96}
          height={96}
          className="size-24 rounded-md border border-line bg-surface object-contain"
        />
      ) : (
        <img
          src={storeImageUrl(image.id, 'large')}
          alt={t('store-profile.banner.alt')}
          width={image.width}
          height={image.height}
          className="aspect-[4/1] w-full rounded-md border border-line bg-muted object-cover"
        />
      )}
      {canEdit ? (
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={input}
            id={inputId}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="peer sr-only"
            disabled={working}
            onChange={(event) => void upload(event.target.files)}
          />
          <label
            htmlFor={inputId}
            className={`inline-flex h-(--mp-size-control) items-center justify-center rounded-md border border-line-control bg-surface px-4 font-medium text-fg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus ${
              working ? 'cursor-not-allowed text-fg-muted' : 'cursor-pointer hover:bg-muted'
            }`}
          >
            {status === 'uploading'
              ? t('store-profile.image.uploading')
              : image === null
                ? t('store-profile.image.choose')
                : t('store-profile.image.replace')}
          </label>
          {image === null ? null : confirming ? (
            <>
              <span className="text-sm">{t(`store-profile.${kind}.confirm`)}</span>
              <Button variant="destructive" onClick={() => void remove()} disabled={working}>
                {t('store-profile.image.remove-yes')}
              </Button>
              <Button variant="link" onClick={() => setConfirming(false)}>
                {t('store-profile.image.cancel')}
              </Button>
            </>
          ) : (
            <Button
              variant="destructive"
              onClick={() => setConfirming(true)}
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
      {status === 'saved' || status === 'removed' ? (
        <p role="status" className="text-sm text-success-fg">
          {t(`store-profile.${kind}.${status}`)}
        </p>
      ) : null}
    </Card>
  );
}
