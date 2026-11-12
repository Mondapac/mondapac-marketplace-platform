'use client';

import { Banner, Button, Dialog, FileButton } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { CategoryProblemBanner } from './category-problem.tsx';
import { prepareImage } from './image-prepare.ts';
import { useCategoryCall } from './use-category-call.ts';
import { API_CATEGORIES, categoryImagePath, type DetailBody, type ImageWrite } from './types.ts';

/** What the picker accepts; the server reads the type from the content and decides. */
const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

/**
 * The category image (categories package C3c): a preview of the current image, or "No image", and
 * for an editor Upload (or Replace) and Remove. The picture is shrunk in the browser, then the API
 * decodes it and writes its own JPEG files. Each write names the category version the page read, so
 * a change by someone else is "Someone changed this category. Reload.". A reader sees the buttons
 * off. The image is optional: Show does not need it.
 */
export function CategoryImageSection({
  body,
  canEdit,
  csrfToken,
  onChanged,
}: {
  readonly body: DetailBody;
  readonly canEdit: boolean;
  readonly csrfToken: string;
  /** A write is done (or the page read old data): read the category again. */
  readonly onChanged: (note?: string) => void;
}) {
  const t = useTranslations('categories.image');
  const call = useCategoryCall(csrfToken);
  const [preparing, setPreparing] = useState(false);
  const [refused, setRefused] = useState<'too-large' | 'unreadable' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const { category, details } = body;
  const imageId = details.imageId;
  const editable = canEdit && (category.status === 'active' || category.status === 'hidden');
  const busy = preparing || call.pending;

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (input.current !== null) input.current.value = '';
    if (file === undefined) return;
    setRefused(null);
    call.clear();
    setPreparing(true);
    const prepared = await prepareImage(file);
    setPreparing(false);
    if (prepared.kind === 'refused') {
      setRefused(prepared.reason);
      return;
    }
    const answer = await call.run<ImageWrite>(
      'PUT',
      `${API_CATEGORIES}/${category.id}/image`,
      { version: category.version, data: prepared.data },
      { namesCategoryVersion: true },
    );
    if (answer.ok) onChanged(t(imageId === null ? 'note-added' : 'note-replaced'));
  }

  return (
    <section aria-labelledby="category-image-title" className="flex flex-col gap-2">
      <h3 id="category-image-title" className="m-0 text-base font-semibold">
        {t('title')}
      </h3>
      {imageId === null ? (
        <p className="m-0 text-sm text-fg-muted">{t('none')}</p>
      ) : (
        <img
          src={categoryImagePath(category.id, imageId, 'medium')}
          alt={t('alt', { slug: category.slug })}
          className="h-auto max-h-48 w-full max-w-xs rounded-md border border-line object-contain"
        />
      )}
      <p className="m-0 text-sm text-fg-muted">{t('help')}</p>
      {refused === null ? null : <Banner tone="critical">{t(`refused-${refused}`)}</Banner>}
      {confirming ? null : <CategoryProblemBanner problem={call.problem} />}
      {!confirming && call.problem?.reload === true ? (
        <div>
          <Button variant="secondary" onClick={() => onChanged()}>
            {t('reload')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap gap-2" role="group" aria-label={t('label')}>
        <FileButton
          accept={IMAGE_ACCEPT}
          inputRef={input}
          disabled={!editable || busy}
          aria-busy={busy}
          onFiles={(files) => void upload(files)}
        >
          {busy ? t('uploading') : t(imageId === null ? 'upload' : 'replace')}
        </FileButton>
        {imageId === null ? null : (
          <Button
            variant="secondary"
            disabled={!editable || busy}
            onClick={() => {
              call.clear();
              setConfirming(true);
            }}
          >
            {t('remove')}
          </Button>
        )}
      </div>
      {confirming ? (
        <RemoveImageDialog
          body={body}
          csrfToken={csrfToken}
          onClose={() => setConfirming(false)}
          onDone={() => {
            setConfirming(false);
            onChanged(t('note-removed'));
          }}
          onReload={() => {
            setConfirming(false);
            onChanged();
          }}
        />
      ) : null}
    </section>
  );
}

function RemoveImageDialog({
  body,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly body: DetailBody;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.image');
  const call = useCategoryCall(csrfToken);
  const cancel = useRef<HTMLButtonElement>(null);

  async function confirm() {
    const answer = await call.run<ImageWrite>(
      'POST',
      `${API_CATEGORIES}/${body.category.id}/image/remove`,
      { version: body.category.version },
      { namesCategoryVersion: true },
    );
    if (answer.ok) onDone();
  }

  return (
    <Dialog
      open
      title={t('remove-title')}
      onClose={onClose}
      initialFocus={cancel}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {call.problem?.reload === true ? (
            <Button onClick={onReload}>{t('reload')}</Button>
          ) : (
            <Button
              variant="destructive-solid"
              loading={call.pending}
              disabled={call.pending}
              onClick={() => void confirm()}
            >
              {t('remove-action')}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <CategoryProblemBanner problem={call.problem} />
        <p className="m-0">{t('remove-body')}</p>
      </div>
    </Dialog>
  );
}
