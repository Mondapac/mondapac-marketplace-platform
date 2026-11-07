'use client';

import { Badge, Banner, Button, Dialog, FileButton, Icon, Menu, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { prepareImage } from '../../categories/image-prepare.ts';
import { imageProblemOf } from './image-errors.ts';
import { BASE, type ProductImage } from './types.ts';

/** The most photos a product's library holds (the API refuses more). */
export const MAX_IMAGES = 8;

/** The URL of a photo's thumbnail (240 px), through this panel's relay. */
export const imageUrl = (productId: string, imageId: string): string =>
  `/api/catalog/admin/products/${productId}/images/${imageId}/thumb`;

/** `images` with `imageId` moved to `to` (0-based, clamped). */
export function moved(images: readonly string[], imageId: string, to: number): string[] {
  const rest = images.filter((id) => id !== imageId);
  const at = Math.max(0, Math.min(to, rest.length));
  return [...rest.slice(0, at), imageId, ...rest.slice(at)];
}

/**
 * The "Images" field of the product card (P1; frames admin-add-product 2 to 8, papMedia): the
 * first photo of the draft is the main one (168 px, primary border, "Main"), the others follow at
 * 80 px with an add tile. Each photo has a menu: Make main, Move left or right, Remove from
 * product, Delete. Uploads go to the library at once; order, main and remove change only the
 * draft's `imageIds`, saved with the form. A library photo the draft does not hold shows "Not in
 * product" and can be added back.
 */
export function ImagesSection({
  productId,
  csrfToken,
  library,
  imageIds,
  onImageIds,
}: {
  readonly productId: string;
  readonly csrfToken: string;
  /** `null` when the photo list could not be read. */
  readonly library: readonly ProductImage[] | null;
  readonly imageIds: readonly string[];
  readonly onImageIds: (ids: string[]) => void;
}) {
  const t = useTranslations('catalog.productForm.images');
  const [photos, setPhotos] = useState<readonly ProductImage[]>(library ?? []);
  const [uploading, setUploading] = useState(0);
  const [problems, setProblems] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const base = `${BASE}/${productId}/images`;

  if (library === null) {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="font-medium">{t('label')}</span>
        <p className="text-sm text-fg-muted">{t('unavailable')}</p>
      </div>
    );
  }

  const fail = (key: string) => setProblems((current) => [...current, key]);
  const room = MAX_IMAGES - photos.length - uploading;
  const inDraft = imageIds
    .map((id) => photos.find((photo) => photo.imageId === id))
    .filter((photo): photo is ProductImage => photo !== undefined);
  const draftIds = inDraft.map((photo) => photo.imageId);
  const outside = photos.filter((photo) => !draftIds.includes(photo.imageId));
  const tiles = [...inDraft, ...outside];

  async function upload(files: FileList | null) {
    if (files === null || files.length === 0) return;
    setProblems([]);
    const chosen = [...files].slice(0, Math.max(0, room));
    if (files.length > chosen.length) fail('limit');
    let ids = [...draftIds];
    setUploading((count) => count + chosen.length);
    for (const file of chosen) {
      const prepared = await prepareImage(file);
      if (prepared.kind === 'refused') {
        fail(prepared.reason === 'too-large' ? 'too-large' : 'unreadable');
      } else {
        const result = await callApi<ProductImage>(
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
          fail(imageProblemOf(result.failure));
        }
      }
      setUploading((count) => count - 1);
    }
    if (input.current !== null) input.current.value = '';
  }

  async function remove(imageId: string) {
    setPending(true);
    setProblems([]);
    const result = await callApi<{ deleted: true }>(
      'DELETE',
      `${base}/${imageId}`,
      undefined,
      csrfToken,
    );
    setPending(false);
    setDeleting(null);
    if (result.ok) {
      setPhotos((current) => current.filter((photo) => photo.imageId !== imageId));
      if (draftIds.includes(imageId)) onImageIds(draftIds.filter((id) => id !== imageId));
      setAnnouncement(t('announce.deleted'));
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else {
      fail(imageProblemOf(result.failure));
    }
  }

  function reorder(imageId: string, to: number) {
    const next = moved(draftIds, imageId, to);
    onImageIds(next);
    setAnnouncement(
      to === 0
        ? t('announce.main', { n: draftIds.indexOf(imageId) + 1 })
        : t('announce.moved', { n: to + 1, total: next.length }),
    );
  }

  function itemsOf(photo: ProductImage): MenuItem[] {
    const position = draftIds.indexOf(photo.imageId);
    const items: MenuItem[] = [];
    if (position < 0) {
      items.push({
        id: 'add-back',
        label: t('menu.add-back'),
        onSelect: () => {
          onImageIds([...draftIds, photo.imageId]);
          setAnnouncement(t('announce.added', { n: draftIds.length + 1 }));
        },
      });
    } else {
      if (position > 0) {
        items.push({
          id: 'main',
          label: t('menu.make-main'),
          onSelect: () => reorder(photo.imageId, 0),
        });
        items.push({
          id: 'left',
          label: t('menu.move-left'),
          onSelect: () => reorder(photo.imageId, position - 1),
        });
      }
      if (position < draftIds.length - 1) {
        items.push({
          id: 'right',
          label: t('menu.move-right'),
          onSelect: () => reorder(photo.imageId, position + 1),
        });
      }
      items.push({
        id: 'remove',
        label: t('menu.remove'),
        onSelect: () => {
          onImageIds(draftIds.filter((id) => id !== photo.imageId));
          setAnnouncement(t('announce.removed'));
        },
      });
    }
    items.push({
      id: 'delete',
      label: t('menu.delete'),
      tone: 'critical',
      onSelect: () => setDeleting(photo.imageId),
    });
    return items;
  }

  function tile(photo: ProductImage, index: number) {
    const main = draftIds.indexOf(photo.imageId) === 0;
    return (
      <li key={photo.imageId} className={`flex flex-col gap-1 ${main ? 'w-full sm:w-42' : 'w-20'}`}>
        <img
          src={imageUrl(productId, photo.imageId)}
          alt={t('alt', { n: index + 1, total: tiles.length })}
          width={main ? 168 : 80}
          height={main ? 168 : 80}
          loading="lazy"
          className={`rounded-md bg-muted object-contain ${
            main ? 'size-42 border-2 border-accent' : 'size-20 border border-line'
          }`}
        />
        <div className={`flex items-center gap-1 ${main ? 'w-42 justify-between' : ''}`}>
          {main ? <Badge tone="success">{t('main')}</Badge> : null}
          <Menu label={t('menu.label', { n: index + 1 })} items={itemsOf(photo)} />
        </div>
      </li>
    );
  }

  const picker = (
    <input
      ref={input}
      type="file"
      multiple
      accept="image/jpeg,image/png,image/webp"
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => void upload(event.target.files)}
    />
  );

  return (
    <div className="flex flex-col gap-2" role="group" aria-labelledby="product-images-label">
      <span id="product-images-label" className="font-medium">
        {t('label')}
      </span>
      <Dialog
        open={deleting !== null}
        title={t('delete.title')}
        onClose={() => setDeleting(null)}
        initialFocus={cancelRef}
        actions={
          <>
            <Button ref={cancelRef} variant="secondary" onClick={() => setDeleting(null)}>
              {t('delete.cancel')}
            </Button>
            <Button
              variant="destructive-solid"
              loading={pending}
              onClick={() => deleting !== null && void remove(deleting)}
            >
              {t('delete.confirm')}
            </Button>
          </>
        }
      >
        {t('delete.message')}
      </Dialog>
      {problems.length > 0 ? (
        <Banner tone="critical">
          <ul className="list-disc ps-5 text-sm">
            {[...new Set(problems)].map((key) => (
              <li key={key}>{t(`error.${key}`)}</li>
            ))}
          </ul>
        </Banner>
      ) : null}
      {tiles.length === 0 && uploading === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-line-control bg-subtle p-7 text-center">
          <FileButton
            multiple
            accept="image/jpeg,image/png,image/webp"
            inputRef={input}
            onFiles={(files) => void upload(files)}
          >
            {t('upload')}
          </FileButton>
          <p className="text-sm text-fg-muted">{t('formats')}</p>
        </div>
      ) : (
        <>
          <ul aria-label={t('label')} className="flex flex-wrap items-start gap-2">
            {inDraft.map((photo, index) => tile(photo, index))}
            {Array.from({ length: uploading }, (_, n) => (
              <li key={`uploading-${n}`}>
                <div
                  role="status"
                  className="flex size-20 animate-pulse items-center justify-center rounded-md bg-muted text-xs text-fg-muted"
                >
                  {t('uploading')}
                </div>
              </li>
            ))}
            {room > 0 ? (
              <li>
                {picker}
                <button
                  type="button"
                  disabled={uploading > 0}
                  aria-label={t('add')}
                  title={t('add')}
                  onClick={() => input.current?.click()}
                  className="flex size-20 items-center justify-center rounded-md border border-line-control bg-subtle text-icon-muted enabled:hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:cursor-not-allowed"
                >
                  <Icon name="plus" />
                </button>
              </li>
            ) : null}
          </ul>
          {outside.length > 0 ? (
            <div className="flex flex-col gap-2">
              <p className="flex flex-wrap items-center gap-2 text-sm text-fg-muted">
                <Badge tone="attention">{t('not-in-product')}</Badge>
                {t('library-only')}
              </p>
              <ul aria-label={t('library-label')} className="flex flex-wrap items-start gap-2">
                {outside.map((photo, index) => tile(photo, inDraft.length + index))}
              </ul>
            </div>
          ) : null}
          <p className="text-sm text-fg-muted">
            {room > 0 ? t('formats') : t('full', { max: MAX_IMAGES })}
          </p>
        </>
      )}
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
