'use client';

import { Banner, Button, CheckboxRow, TextAreaField, TextField, toast } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { formatInstantInZone } from '../../shared/format.ts';
import { instantToLocal, localToInstant } from '../../content/slides/zone-time.ts';
import { isStepUpCancelled, useGuardedCall } from '../../step-up/step-up.tsx';
import { editorProblemOf, type EditorProblem } from '../editor/editor-errors.ts';
import type { PostDetail } from '../editor/types.ts';
import { API_BLOG_POSTS } from '../types.ts';

const REASON_MAX = 300;

type Action =
  'publish' | 'schedule' | 'unschedule' | 'pause' | 'resume' | 'archive' | 'featured' | 'slug';

/**
 * What an admin can do with an approved or live post (design A4): publish now or schedule it, take
 * it off the site, put it back, archive it, feature it, change its address. Times are read and
 * shown on the Market's clock. The server decides every time: it applies the permission and the
 * two-step code rule, and refuses a state the post is not in; this panel only offers what fits the
 * status it was given and shows the server's refusal.
 */
export function PublishPanel({
  post,
  zone,
  canPublish,
  canPause,
  csrfToken,
  locale,
  onChanged,
}: {
  readonly post: PostDetail;
  readonly zone: string;
  readonly canPublish: boolean;
  readonly canPause: boolean;
  readonly csrfToken: string;
  readonly locale: string;
  /** The post changed on the server: the page reads it again. */
  readonly onChanged: () => void;
}) {
  const t = useTranslations('blog.publish');
  const tr = useTranslations('blog.review');
  const guarded = useGuardedCall();
  const [busy, setBusy] = useState<Action | null>(null);
  const [problem, setProblem] = useState<EditorProblem | null>(null);
  const [when, setWhen] = useState(() =>
    post.scheduledAt === null || post.scheduledAt === undefined
      ? ''
      : instantToLocal(post.scheduledAt, zone),
  );
  const [reason, setReason] = useState('');
  const [slug, setSlug] = useState(post.slug);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const working = useRef(false);

  // A live post whose new version was approved keeps the status `published`: it can still be
  // published (the new version) or scheduled, so the offer follows the version, not the status.
  const unpublished = post.status === 'unpublished';
  const archived = post.status === 'archived';
  const published = post.status === 'published';
  const approved = post.open?.state === 'approved' && !unpublished && !archived;
  const scheduled = post.scheduledAt !== null && post.scheduledAt !== undefined && !archived;
  if (!approved && !scheduled && !published && !unpublished) return null;
  const versionNo = post.open?.versionNo ?? null;
  const base = `${API_BLOG_POSTS}/${post.id}`;
  const scheduledInstant = localToInstant(when, zone);

  async function run(
    action: Action,
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
    done: string,
  ) {
    if (working.current) return;
    working.current = true;
    setBusy(action);
    const result = await guarded<PostDetail>(method, `${base}/${path}`, body, csrfToken);
    working.current = false;
    setBusy(null);
    if (result.ok) {
      setProblem(null);
      toast.success(t(done));
      onChanged();
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = editorProblemOf(result.failure);
    setProblem(next);
    if (next.reload) onChanged();
  }

  const disabled = busy !== null;
  const key = problem === null ? null : problem.key.replace('blog.editor.error.', 'problem.');
  return (
    <section
      aria-label={t('title')}
      className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
    >
      <h3 className="text-base font-semibold">{t('title')}</h3>
      {key !== null ? (
        <Banner tone="critical">
          <span>{tr.has(key) ? tr(key) : tr('problem.unknown')}</span>
        </Banner>
      ) : null}
      {scheduled && post.scheduledAt ? (
        <p>{t('scheduled-for', { at: formatInstantInZone(post.scheduledAt, locale, zone) })}</p>
      ) : null}
      {published && post.publishedAt ? (
        <p>{t('live-since', { at: formatInstantInZone(post.publishedAt, locale, zone) })}</p>
      ) : null}
      {unpublished ? (
        <p>
          {post.pausedReason ? t('paused-because', { reason: post.pausedReason }) : t('paused')}
        </p>
      ) : null}

      {(approved || scheduled) && canPublish ? (
        <div className="flex flex-col gap-3">
          {approved && versionNo !== null ? (
            <div>
              <Button
                loading={busy === 'publish'}
                disabled={disabled}
                onClick={() => void run('publish', 'POST', 'publish', { versionNo }, 'published')}
              >
                {t('publish-now')}
              </Button>
              <p className="mt-1 text-sm text-fg-muted">{t('publish-now-help')}</p>
            </div>
          ) : null}
          {versionNo !== null ? (
            <div className="flex flex-col gap-2">
              <TextField
                label={t('schedule-at')}
                type="datetime-local"
                value={when}
                help={
                  scheduledInstant === null
                    ? t('zone-note', { zone })
                    : `${t('zone-note', { zone })} ${t('goes-live-preview', { at: formatInstantInZone(scheduledInstant, locale, zone) })}`
                }
                disabled={disabled}
                onChange={(event) => setWhen(event.target.value)}
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  loading={busy === 'schedule'}
                  disabled={disabled || scheduledInstant === null}
                  onClick={() =>
                    void run(
                      'schedule',
                      'PUT',
                      'schedule',
                      { versionNo, scheduledAt: scheduledInstant },
                      'scheduled',
                    )
                  }
                >
                  {t('schedule')}
                </Button>
                {scheduled ? (
                  <Button
                    variant="secondary"
                    loading={busy === 'unschedule'}
                    disabled={disabled}
                    onClick={() =>
                      void run('unschedule', 'DELETE', 'schedule', undefined, 'unscheduled')
                    }
                  >
                    {t('unschedule')}
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {published && canPause ? (
        <div className="flex flex-col gap-2">
          <TextAreaField
            label={t('pause-reason')}
            help={t('pause-help')}
            value={reason}
            rows={2}
            maxLength={REASON_MAX}
            counter={`${reason.length} / ${REASON_MAX}`}
            disabled={disabled}
            onChange={(event) => setReason(event.target.value)}
          />
          <div>
            <Button
              variant="secondary"
              loading={busy === 'pause'}
              disabled={disabled || reason.trim().length === 0}
              onClick={() =>
                void run('pause', 'POST', 'pause', { reason: reason.trim() }, 'paused-done')
              }
            >
              {t('pause')}
            </Button>
          </div>
        </div>
      ) : null}

      {unpublished && canPublish ? (
        <div>
          <Button
            loading={busy === 'resume'}
            disabled={disabled}
            onClick={() => void run('resume', 'POST', 'resume', undefined, 'resumed')}
          >
            {t('resume')}
          </Button>
          <p className="mt-1 text-sm text-fg-muted">{t('resume-help')}</p>
        </div>
      ) : null}

      {published && canPublish ? (
        <div className="flex flex-col gap-3">
          <CheckboxRow
            label={t('featured')}
            help={t('featured-help')}
            checked={post.featured === true}
            disabled={disabled}
            onChange={() =>
              void run(
                'featured',
                'PUT',
                'featured',
                { featured: post.featured !== true },
                'featured-done',
              )
            }
          />
          <TextField
            label={t('slug')}
            help={t('slug-help')}
            value={slug}
            disabled={disabled}
            onChange={(event) => setSlug(event.target.value)}
          />
          <div>
            <Button
              variant="secondary"
              loading={busy === 'slug'}
              disabled={disabled || slug.trim() === post.slug || slug.trim().length === 0}
              onClick={() => void run('slug', 'PUT', 'slug', { slug: slug.trim() }, 'slug-done')}
            >
              {t('slug-save')}
            </Button>
          </div>
        </div>
      ) : null}

      {(published || unpublished) && canPublish && post.ownerType === 'platform' ? (
        <div className="flex flex-col gap-2">
          {confirmArchive ? (
            <>
              <p role="alert">{t('archive-confirm')}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="destructive-solid"
                  loading={busy === 'archive'}
                  disabled={disabled}
                  onClick={() => void run('archive', 'POST', 'archive', undefined, 'archived')}
                >
                  {t('archive')}
                </Button>
                <Button
                  variant="secondary"
                  disabled={disabled}
                  onClick={() => setConfirmArchive(false)}
                >
                  {t('cancel')}
                </Button>
              </div>
            </>
          ) : (
            <div>
              <Button
                variant="secondary"
                disabled={disabled}
                onClick={() => setConfirmArchive(true)}
              >
                {t('archive')}
              </Button>
              <p className="mt-1 text-sm text-fg-muted">{t('archive-help')}</p>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
