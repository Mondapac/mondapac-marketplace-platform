'use client';

import { Banner, Button, Dialog, FileButton, LoadError } from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { prepareImage } from '../../categories/image-prepare.ts';
import { API_BLOG_MEDIA, mediaUrl } from '../types.ts';
import { mediaProblemOf } from './media-errors.ts';
import type { MediaItem, MediaPage } from './types.ts';

/** Base64 characters of 4 MiB decoded: ceil(4194304 / 3) * 4. */
export const MAX_BASE64_CHARS = 5_592_408;
export const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

type Load = 'loading' | 'ready' | 'failed';

/**
 * The media library as a dialog (blog media): a grid of thumbnails, newest first, with Load more,
 * and an Upload button for a session that holds `blog.media.edit`. Choosing a picture calls
 * `onPick` and closes; a new upload is used at once. The alt text stays on the post.
 */
export function MediaPickerDialog({
  open,
  onClose,
  onPick,
  currentId,
  canUpload,
  csrfToken,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** `uploaded` is true for a picture the person just uploaded (the caller moves focus on). */
  readonly onPick: (id: string, uploaded: boolean) => void;
  /** The picture already chosen, marked in the grid. */
  readonly currentId: string;
  readonly canUpload: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('blog.media');
  // While an upload runs the dialog cannot be closed (Close, Escape, the backdrop), so the result
  // is never lost behind a closed dialog.
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={() => {
        if (!busy) onClose();
      }}
      size="form"
      actions={
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          {t('close')}
        </Button>
      }
    >
      <Library
        onBusy={setBusy}
        onPick={(id, uploaded) => {
          onPick(id, uploaded);
          onClose();
        }}
        currentId={currentId}
        canUpload={canUpload}
        csrfToken={csrfToken}
      />
    </Dialog>
  );
}

/** The body of the dialog; it mounts when the dialog opens, so every opening reads page 1 again. */
function Library({
  onBusy,
  onPick,
  currentId,
  canUpload,
  csrfToken,
}: {
  readonly onBusy: (busy: boolean) => void;
  readonly onPick: (id: string, uploaded: boolean) => void;
  readonly currentId: string;
  readonly canUpload: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('blog.media');
  const format = useFormatter();
  const [load, setLoad] = useState<Load>('loading');
  const [items, setItems] = useState<readonly MediaItem[]>([]);
  const [page, setPage] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [more, setMore] = useState<'idle' | 'busy' | 'failed'>('idle');
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [announce, setAnnounce] = useState('');
  const gone = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  const grid = useRef<HTMLUListElement>(null);
  /** The first picture of the page Load more just added: it takes focus, as the button goes away. */
  const focusId = useRef<string | null>(null);

  useEffect(() => {
    onBusy(uploading);
    return () => onBusy(false);
  }, [uploading, onBusy]);

  useEffect(() => {
    const target = focusId.current;
    if (target === null) return;
    focusId.current = null;
    grid.current?.querySelector<HTMLElement>(`[data-media-id="${target}"]`)?.focus();
  }, [items]);

  const read = useCallback(async (next: number, known?: ReadonlySet<string>): Promise<boolean> => {
    const result = await callApi<MediaPage>('GET', `${API_BLOG_MEDIA}?page=${next}`);
    if (gone.current) return false;
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      return false;
    }
    const fresh = result.body.items.find((item) => !known?.has(item.id));
    if (known !== undefined && fresh !== undefined) focusId.current = fresh.id;
    setItems((current) => {
      const seen = new Set(current.map((item) => item.id));
      return [...current, ...result.body.items.filter((item) => !seen.has(item.id))];
    });
    setPage(result.body.page);
    setHasMore(result.body.hasMore);
    return true;
  }, []);

  const first = useCallback(async () => {
    setLoad('loading');
    setItems([]);
    const ok = await read(1);
    if (!gone.current) setLoad(ok ? 'ready' : 'failed');
  }, [read]);

  useEffect(() => {
    gone.current = false;
    void first();
    return () => {
      gone.current = true;
    };
  }, [first]);

  async function loadMore() {
    setMore('busy');
    const known = new Set(items.map((item) => item.id));
    const ok = await read(page + 1, known);
    if (!gone.current) {
      setMore(ok ? 'idle' : 'failed');
      if (ok) setAnnounce(t('more-loaded'));
    }
  }

  async function upload(files: FileList | null) {
    const file = files?.[0];
    if (file === undefined || uploading) return;
    setProblem(null);
    // Checked here so a wrong file never leaves the browser; the server checks again.
    if (!(ACCEPTED_TYPES as readonly string[]).includes(file.type)) {
      setProblem('unsupported');
      if (input.current !== null) input.current.value = '';
      return;
    }
    setUploading(true);
    const prepared = await prepareImage(file);
    if (prepared.kind === 'refused') {
      setProblem(prepared.reason === 'too-large' ? 'too-large' : 'unreadable');
    } else if (prepared.data.length > MAX_BASE64_CHARS) {
      // The server refuses more than 4 MiB decoded; do not send what is certain to be refused.
      setProblem('too-large');
    } else {
      const result = await callApi<MediaItem>(
        'POST',
        API_BLOG_MEDIA,
        { data: prepared.data },
        csrfToken,
      );
      if (gone.current) return;
      if (result.ok) {
        setUploading(false);
        onPick(result.body.id, true);
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setProblem(mediaProblemOf(result.failure));
    }
    if (gone.current) return;
    setUploading(false);
    if (input.current !== null) input.current.value = '';
  }

  return (
    <div className="flex flex-col gap-4 text-fg">
      {canUpload ? (
        <div className="flex flex-wrap items-center gap-3">
          <FileButton
            inputRef={input}
            accept={ACCEPTED_TYPES.join(',')}
            disabled={uploading}
            onFiles={(files) => void upload(files)}
          >
            {uploading ? t('uploading') : t('upload')}
          </FileButton>
          <span className="text-sm text-fg-muted">{t('upload-help')}</span>
        </div>
      ) : (
        <p className="text-sm text-fg-muted">{t('no-upload')}</p>
      )}
      <div aria-live="polite" className="sr-only">
        {uploading ? t('uploading') : announce}
      </div>
      {problem !== null ? (
        <Banner tone="critical">
          <span>{t(`error.${problem}`)}</span>
        </Banner>
      ) : null}
      {load === 'loading' ? (
        <div role="status">
          <span className="sr-only">{t('loading')}</span>
          <ul
            aria-hidden="true"
            className="grid grid-cols-2 gap-3 motion-safe:animate-pulse sm:grid-cols-3"
          >
            {Array.from({ length: 6 }, (_, index) => (
              <li key={index} className="aspect-square rounded-md bg-muted" />
            ))}
          </ul>
        </div>
      ) : null}
      {load === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('load-error')}
          retryLabel={t('retry')}
          onRetry={() => void first()}
        />
      ) : null}
      {load === 'ready' && items.length === 0 ? (
        <p className="text-fg-muted">{canUpload ? t('empty') : t('empty-readonly')}</p>
      ) : null}
      {items.length > 0 ? (
        <ul ref={grid} aria-label={t('grid')} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item) => {
            const current = item.id === currentId;
            const label = t(current ? 'choose-current' : 'choose', {
              date: format.dateTime(new Date(item.createdAt), {
                dateStyle: 'medium',
                timeStyle: 'short',
              }),
              width: item.width,
              height: item.height,
            });
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-label={label}
                  aria-current={current ? 'true' : undefined}
                  data-media-id={item.id}
                  disabled={uploading}
                  onClick={() => onPick(item.id, false)}
                  className={`relative block w-full overflow-hidden rounded-md border-2 bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60 ${
                    current ? 'border-accent' : 'border-line'
                  }`}
                >
                  {/* The button names the picture; the thumbnail itself is decoration. */}
                  <img
                    src={mediaUrl(item.id, 'thumb')}
                    alt=""
                    loading="lazy"
                    className="aspect-square w-full object-cover"
                  />
                  {current ? (
                    // A mark, not only a colour: a check badge on the tile that is in use.
                    <span
                      aria-hidden="true"
                      className="absolute end-1 top-1 flex size-6 items-center justify-center rounded-full bg-accent text-on-accent"
                    >
                      <svg
                        viewBox="0 0 24 24"
                        className="size-4"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12l5 5 9-10" />
                      </svg>
                    </span>
                  ) : null}
                  <span
                    aria-hidden="true"
                    className="block bg-surface px-2 py-1 text-start text-xs text-fg-muted"
                  >
                    {item.width}×{item.height}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      {load === 'ready' && hasMore ? (
        <div className="flex flex-col items-start gap-2">
          <Button
            variant="secondary"
            loading={more === 'busy'}
            disabled={uploading}
            onClick={() => void loadMore()}
          >
            {t('load-more')}
          </Button>
          {more === 'failed' ? (
            <p role="alert" className="text-sm text-critical-fg">
              {t('more-error')}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
