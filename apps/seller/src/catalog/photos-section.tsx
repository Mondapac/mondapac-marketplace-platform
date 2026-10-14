'use client';

import { Badge, Banner, Button, Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { photoProblemOf } from './photo-errors.ts';
import { preparePhoto } from './photo-prepare.ts';
import type { ProductPhoto } from './types.ts';

/** The most photos a product's library holds (the API refuses more). */
export const MAX_PHOTOS = 8;

/** The URL of one size of a photo, through this panel's relay. */
export const photoUrl = (productId: string, imageId: string, size: 'thumb' | 'medium'): string =>
  `/api/catalog/seller/products/${productId}/images/${imageId}/${size}`;

/**
 * The photos of a product: upload (shrunk in the browser first), make one the main photo, take
 * one off the product or delete it. `imageIds` is the draft's ordered list; the first is the main
 * photo. A photo in the library but not in the draft is shown as such and can be added back. The
 * parent saves the draft; this section only changes the list and tells the parent.
 */
export function PhotosSection({
  productId,
  csrfToken,
  library,
  imageIds,
  onImageIds,
}: {
  readonly productId: string;
  readonly csrfToken: string;
  /** `null` when the photo list could not be read. */
  readonly library: readonly ProductPhoto[] | null;
  readonly imageIds: readonly string[];
  readonly onImageIds: (ids: string[]) => void;
}) {
  const t = useTranslations();
  const [photos, setPhotos] = useState<readonly ProductPhoto[]>(library ?? []);
  const [uploading, setUploading] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);
  const [confirming, setConfirming] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const base = `catalog/seller/products/${productId}/images`;

  if (library === null) {
    return (
      <Card title={t('catalog.edit.photos.title')}>
        <p className="text-sm text-fg-muted">{t('catalog.edit.photos.unavailable')}</p>
      </Card>
    );
  }

  const fail = (key: string) => setProblems((current) => [...current, key]);
  const room = MAX_PHOTOS - photos.length;

  async function upload(files: FileList | null) {
    if (files === null || files.length === 0) return;
    setProblems([]);
    const chosen = [...files].slice(0, Math.max(0, room));
    if (files.length > chosen.length) fail('limit');
    let ids = [...imageIds];
    for (const file of chosen) {
      setUploading((count) => count + 1);
      const prepared = await preparePhoto(file);
      if (prepared.kind === 'refused') {
        fail(prepared.reason === 'too-large' ? 'too-large' : 'unreadable');
      } else {
        const result = await callApi<ProductPhoto>(
          'POST',
          base,
          { data: prepared.data },
          csrfToken,
        );
        if (result.ok) {
          setPhotos((current) => [...current, result.body]);
          ids = [...ids, result.body.imageId];
          onImageIds(ids);
        } else if (result.failure.status === 401) {
          window.location.assign('/session-ended');
        } else {
          fail(photoProblemOf(result.failure));
        }
      }
      setUploading((count) => count - 1);
    }
    if (input.current !== null) input.current.value = '';
  }

  async function remove(imageId: string) {
    setConfirming(null);
    setProblems([]);
    const result = await callApi<{ deleted: true }>(
      'DELETE',
      `${base}/${imageId}`,
      undefined,
      csrfToken,
    );
    if (result.ok) {
      setPhotos((current) => current.filter((photo) => photo.imageId !== imageId));
      if (imageIds.includes(imageId)) onImageIds(imageIds.filter((id) => id !== imageId));
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else {
      fail(photoProblemOf(result.failure));
    }
  }

  const inDraft = imageIds
    .map((id) => photos.find((photo) => photo.imageId === id))
    .filter((photo): photo is ProductPhoto => photo !== undefined);
  const outside = photos.filter((photo) => !imageIds.includes(photo.imageId));
  const tiles = [...inDraft, ...outside];

  return (
    <Card title={t('catalog.edit.photos.title')}>
      <p className="text-sm text-fg-muted">
        {t('catalog.edit.photos.help', { count: photos.length, max: MAX_PHOTOS })}
      </p>
      {problems.length > 0 ? (
        <Banner tone="critical">
          <ul className="list-disc ps-5 text-sm">
            {[...new Set(problems)].map((key) => (
              <li key={key}>{t(`catalog.edit.photos.error.${key}`)}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {tiles.length === 0 ? (
        <p className="rounded-md border border-dashed border-line p-4 text-sm text-fg-muted">
          {t('catalog.edit.photos.empty')}
        </p>
      ) : (
        <ul
          aria-label={t('catalog.edit.photos.title')}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
        >
          {tiles.map((photo) => {
            const position = imageIds.indexOf(photo.imageId);
            const main = position === 0;
            return (
              <li
                key={photo.imageId}
                className="flex min-w-0 flex-col gap-2 rounded-lg border border-line p-2"
              >
                <img
                  src={photoUrl(productId, photo.imageId, 'medium')}
                  alt={t('catalog.edit.photos.alt', {
                    n: position >= 0 ? position + 1 : tiles.indexOf(photo) + 1,
                  })}
                  width={photo.width}
                  height={photo.height}
                  loading="lazy"
                  className="aspect-square w-full rounded-md bg-muted object-contain"
                />
                <div>
                  {main ? (
                    <Badge tone="success">{t('catalog.edit.photos.main')}</Badge>
                  ) : position < 0 ? (
                    <Badge tone="attention">{t('catalog.edit.photos.not-in-product')}</Badge>
                  ) : (
                    <Badge tone="neutral">
                      {t('catalog.edit.photos.position', { n: position + 1 })}
                    </Badge>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {position > 0 ? (
                    <Button
                      variant="secondary"
                      onClick={() =>
                        onImageIds([
                          photo.imageId,
                          ...imageIds.filter((id) => id !== photo.imageId),
                        ])
                      }
                    >
                      {t('catalog.edit.photos.make-main')}
                    </Button>
                  ) : null}
                  {position >= 0 ? (
                    <Button
                      variant="secondary"
                      onClick={() => onImageIds(imageIds.filter((id) => id !== photo.imageId))}
                    >
                      {t('catalog.edit.photos.take-off')}
                    </Button>
                  ) : (
                    <Button
                      variant="secondary"
                      disabled={imageIds.length >= MAX_PHOTOS}
                      onClick={() => onImageIds([...imageIds, photo.imageId])}
                    >
                      {t('catalog.edit.photos.add-back')}
                    </Button>
                  )}
                  {confirming === photo.imageId ? (
                    <>
                      <Button variant="destructive" onClick={() => void remove(photo.imageId)}>
                        {t('catalog.edit.photos.delete-yes')}
                      </Button>
                      <Button variant="link" onClick={() => setConfirming(null)}>
                        {t('catalog.edit.photos.cancel')}
                      </Button>
                    </>
                  ) : (
                    <Button variant="destructive" onClick={() => setConfirming(photo.imageId)}>
                      {t('catalog.edit.photos.delete')}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          id="photo-upload"
          type="file"
          multiple
          accept="image/jpeg,image/png,image/webp"
          className="peer sr-only"
          disabled={uploading > 0 || room <= 0}
          onChange={(event) => void upload(event.target.files)}
        />
        <label
          htmlFor="photo-upload"
          className={`inline-flex h-(--mp-size-control) items-center justify-center rounded-md border border-line-control bg-surface px-4 font-medium text-fg peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-focus ${
            uploading > 0 || room <= 0
              ? 'cursor-not-allowed text-fg-muted'
              : 'cursor-pointer hover:bg-muted'
          }`}
        >
          {uploading > 0 ? t('catalog.edit.photos.uploading') : t('catalog.edit.photos.add')}
        </label>
        <span className="text-sm text-fg-muted">{t('catalog.edit.photos.formats')}</span>
      </div>
    </Card>
  );
}
