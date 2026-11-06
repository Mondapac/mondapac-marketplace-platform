'use client';

import { Button, FileButton, SettingRow, SettingsSection } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useLayoutEffect, useRef } from 'react';
import { storeImageUrl, type ImageKind, type StoreImageRef } from './types.ts';

/** The picture a row shows now: the saved one, the file chosen but not saved yet, or none. */
export type PictureView =
  | { readonly kind: 'none' }
  | { readonly kind: 'saved'; readonly image: StoreImageRef }
  | { readonly kind: 'staged'; readonly data: string };

export interface PictureProps {
  readonly view: PictureView;
  /** The picture differs from the saved one (chosen or removed, not yet saved). */
  readonly changed: boolean;
  /** The chosen file is being shrunk in the browser. */
  readonly preparing: boolean;
  /** The server refused this picture on the last save: the row's error. */
  readonly error: string | undefined;
  /** The browser could not take the chosen file; nothing is staged. */
  readonly notice: string | undefined;
  readonly onChoose: (files: FileList | null) => void;
  readonly onRemove: () => void;
}

export const pictureRowId = (kind: ImageKind) => `setting-${kind}`;

/** The size of each preview box (the spec's 56 x 56 logo and 160 x 40 banner). */
const BOX: Record<ImageKind, string> = { logo: 'size-14', banner: 'h-10 w-40' };

function PictureRow({
  kind,
  picture,
  canEdit,
  busy,
}: {
  readonly kind: ImageKind;
  readonly picture: PictureProps;
  readonly canEdit: boolean;
  readonly busy: boolean;
}) {
  const t = useTranslations();
  const input = useRef<HTMLInputElement>(null);
  const focusPicker = useRef(false);
  const { view } = picture;
  const working = busy || picture.preparing;

  // The Remove button goes with the picture: focus moves to the way to choose another, in the same
  // commit as the change.
  useLayoutEffect(() => {
    if (!focusPicker.current) return;
    focusPicker.current = false;
    input.current?.focus();
  });

  const src =
    view.kind === 'saved'
      ? storeImageUrl(view.image.id, kind === 'logo' ? 'small' : 'large')
      : view.kind === 'staged'
        ? `data:image/jpeg;base64,${view.data}`
        : null;

  return (
    <SettingRow
      id={pictureRowId(kind)}
      label={t(`store-profile.${kind}.title`)}
      help={t(`store-profile.${kind}.help`)}
      error={picture.error}
      changed={picture.changed}
      disabled={!canEdit}
      group
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          {src === null ? (
            <div
              className={`flex ${BOX[kind]} shrink-0 items-center justify-center rounded-md border border-dashed border-line px-1 text-center text-xs text-fg-muted`}
            >
              {t(`store-profile.${kind}.none`)}
            </div>
          ) : (
            <img
              src={src}
              alt={t(`store-profile.${kind}.alt`)}
              className={`${BOX[kind]} shrink-0 rounded-md border bg-surface ${
                kind === 'logo' ? 'object-contain' : 'object-cover'
              } ${picture.changed ? 'border-attention-solid ring-2 ring-attention-border' : 'border-line'} ${
                working ? 'opacity-50' : ''
              }`}
            />
          )}
          {canEdit ? (
            <div className="flex flex-wrap items-center gap-3">
              <FileButton
                inputRef={input}
                accept="image/jpeg,image/png,image/webp"
                disabled={working}
                onFiles={(files) => {
                  picture.onChoose(files);
                  if (input.current !== null) input.current.value = '';
                }}
              >
                {view.kind === 'none'
                  ? t('store-profile.image.choose')
                  : t('store-profile.image.replace')}
              </FileButton>
              {view.kind === 'none' ? null : (
                <Button
                  variant="link"
                  disabled={working}
                  onClick={() => {
                    focusPicker.current = true;
                    picture.onRemove();
                  }}
                >
                  {t('store-profile.image.remove')}
                </Button>
              )}
            </div>
          ) : null}
        </div>
        {picture.notice === undefined ? null : (
          <p role="alert" className="text-sm text-critical-fg">
            {picture.notice}
          </p>
        )}
        {/* Always in the page, so a screen reader hears the text when it is put in. */}
        <p role="status" className="text-sm text-fg-muted empty:sr-only">
          {picture.preparing ? t('store-profile.image.preparing') : null}
        </p>
      </div>
    </SettingRow>
  );
}

/**
 * The Pictures section of the store profile: the logo and the banner as rows of the one form.
 * Replace and Remove stage the change here (with a preview); the page's save bar saves it with the
 * text, and Discard puts the saved pictures back.
 */
export function PicturesSection({
  pictures,
  canEdit,
  saving,
}: {
  readonly pictures: Readonly<Record<ImageKind, PictureProps>>;
  readonly canEdit: boolean;
  readonly saving: boolean;
}) {
  const t = useTranslations();
  return (
    <SettingsSection
      title={t('store-profile.pictures.title')}
      description={t('store-profile.pictures.help')}
    >
      <PictureRow kind="logo" picture={pictures.logo} canEdit={canEdit} busy={saving} />
      <PictureRow kind="banner" picture={pictures.banner} canEdit={canEdit} busy={saving} />
    </SettingsSection>
  );
}
