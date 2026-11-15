'use client';

import { Banner, Button, Dialog, FileButton, LoadError, SkeletonRows } from '@mondapac/ui';
import { useFormatter, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { prepareImage } from '../../categories/image-prepare.ts';
import { API_BLOG_MEDIA, mediaUrl } from '../types.ts';
import { mediaProblemOf } from './media-errors.ts';
import type { MediaItem, MediaPage } from './types.ts';

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
  readonly onPick: (id: string) => void;
  /** The picture already chosen, marked in the grid. */
  readonly currentId: string;
  readonly canUpload: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('blog.media');
  return (
    <Dialog
      open={open}
      title={t('title')}
      onClose={onClose}
      size="form"
      actions={
        <Button variant="secondary" onClick={onClose}>
          {t('close')}
        </Button>
      }
    >
      <Library
        onPick={(id) => {
          onPick(id);
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
  onPick,
  currentId,
  canUpload,
  csrfToken,
}: {
  readonly onPick: (id: string) => void;
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

  const read = useCallback(async (next: number): Promise<boolean> => {
    const result = await callApi<MediaPage>('GET', `${API_BLOG_MEDIA}?page=${next}`);
    if (gone.current) return false;
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      return false;
    }
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
    const ok = await read(page + 1);
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
        onPick(result.body.id);
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
      {load === 'loading' ? <SkeletonRows label={t('loading')} rows={3} /> : null}
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
        <ul aria-label={t('grid')} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {items.map((item) => {
            const label = t('choose', {
              date: format.dateTime(new Date(item.createdAt), { dateStyle: 'medium' }),
              width: item.width,
              height: item.height,
            });
            const current = item.id === currentId;
            return (
              <li key={item.id}>
                <button
                  type="button"
                  aria-label={label}
                  aria-pressed={current}
                  disabled={uploading}
                  onClick={() => onPick(item.id)}
                  className={`block w-full overflow-hidden rounded-md border-2 bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-60 ${
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
