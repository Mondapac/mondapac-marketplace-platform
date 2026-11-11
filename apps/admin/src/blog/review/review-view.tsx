'use client';

import {
  Badge,
  Banner,
  BackLink,
  Button,
  LinkButton,
  LoadError,
  SkeletonRows,
  TextAreaField,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { isStepUpCancelled, useGuardedCall } from '../../step-up/step-up.tsx';
import { editorProblemOf, type EditorProblem } from '../editor/editor-errors.ts';
import type { ChecksBody, Finding, PostDetail } from '../editor/types.ts';
import { API_BLOG_POSTS, BLOG_PATH, postPath } from '../types.ts';
import { changesOf } from './review-model.ts';

const SEVERITY_TONE = { error: 'critical', warning: 'attention', notice: 'info' } as const;
const NOTE_MAX = 1000;

type Load = 'loading' | 'ready' | 'failed';

/**
 * The review page of one post (design A3): what changed since the live version, the automatic
 * checks, and the two decisions. The server decides every time: approval is refused for the
 * author of the version (unless the Market allows it, then a two-step code is asked), and a
 * version with an error finding cannot be approved.
 */
export function ReviewView({
  postId,
  canReview,
  csrfToken,
}: {
  readonly postId: string;
  readonly canReview: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('blog.review');
  const te = useTranslations('blog.editor');
  const tc = useTranslations('blog');
  const guarded = useGuardedCall();
  const [load, setLoad] = useState<Load>('loading');
  const [post, setPost] = useState<PostDetail | null>(null);
  const [findings, setFindings] = useState<readonly Finding[] | null>(null);
  const [busy, setBusy] = useState<'approve' | 'send-back' | null>(null);
  const [problem, setProblem] = useState<EditorProblem | null>(null);
  const [asking, setAsking] = useState(false);
  const [note, setNote] = useState('');
  const working = useRef(false);

  const fetchAll = useCallback(async () => {
    setLoad('loading');
    const one = await callApi<PostDetail>('GET', `${API_BLOG_POSTS}/${postId}`);
    if (!one.ok) {
      if (one.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setLoad('failed');
      return;
    }
    setPost(one.body);
    setFindings(null);
    if (one.body.open?.state === 'in_review') {
      const checks = await callApi<ChecksBody>('GET', `${API_BLOG_POSTS}/${postId}/checks`);
      if (checks.ok) setFindings(checks.body.findings);
    }
    setLoad('ready');
  }, [postId]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  if (load === 'loading') return <SkeletonRows rows={6} label={t('loading')} />;
  if (load === 'failed' || post === null) {
    return (
      <LoadError
        message={t('load-error')}
        retryLabel={t('retry')}
        onRetry={() => void fetchAll()}
      />
    );
  }

  const open = post.open;
  const waiting = post.status === 'in_review' && open !== null;
  const changes = open === null ? [] : changesOf(open.content, post.live?.content ?? null);

  async function decide(kind: 'approve' | 'send-back') {
    if (working.current || open === null) return;
    working.current = true;
    setBusy(kind);
    const path =
      kind === 'approve'
        ? `${API_BLOG_POSTS}/${postId}/approve`
        : `${API_BLOG_POSTS}/${postId}/request-changes`;
    const body =
      kind === 'approve'
        ? { versionNo: open.versionNo }
        : { versionNo: open.versionNo, note: note.trim() };
    const result = await guarded<PostDetail>('POST', path, body, csrfToken);
    working.current = false;
    setBusy(null);
    if (result.ok) {
      setProblem(null);
      toast.success(t(kind === 'approve' ? 'approved' : 'sent-back'));
      setAsking(false);
      setNote('');
      void fetchAll();
      return;
    }
    if (isStepUpCancelled(result)) return;
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = editorProblemOf(result.failure);
    setProblem(next);
    if (next.findings.length > 0) setFindings(next.findings);
    if (next.reload) void fetchAll();
  }

  const noteOk = note.trim().length > 0 && note.length <= NOTE_MAX;
  const disabled = !canReview || !waiting || busy !== null;

  return (
    <div className="flex flex-col gap-4">
      <BackLink href={BLOG_PATH} label={tc('title')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h2 className="text-xl font-semibold">{open?.content.title ?? t('untitled')}</h2>
          <p className="text-sm text-fg-muted">
            {tc(`kind.${post.kind}`)} · {t('version', { no: open?.versionNo ?? 0 })} ·{' '}
            {post.live === null ? t('not-live') : t('live-version', { no: post.live.versionNo })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <LinkButton variant="secondary" href={postPath(postId)}>
            {t('open-editor')}
          </LinkButton>
          <Button
            variant="secondary"
            disabled={disabled || asking}
            onClick={() => {
              setProblem(null);
              setAsking(true);
            }}
          >
            {t('request-changes')}
          </Button>
          <Button
            loading={busy === 'approve'}
            disabled={disabled}
            onClick={() => void decide('approve')}
          >
            {t('approve')}
          </Button>
        </div>
      </div>
      {!canReview ? <Banner tone="info">{t('read-only')}</Banner> : null}
      {!waiting ? <Banner tone="info">{t('not-waiting')}</Banner> : null}
      {open?.editedByReviewer ? <Banner tone="info">{te('edited-by-reviewer')}</Banner> : null}
      {problem !== null ? (
        <Banner tone="critical">
          <span>{t(problem.key.replace('blog.editor.error.', 'problem.'))}</span>
        </Banner>
      ) : null}
      {asking ? (
        <section
          aria-label={t('request-changes')}
          className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
        >
          <h3 className="text-base font-semibold">{t('request-changes')}</h3>
          <TextAreaField
            label={t('note')}
            help={t('note-help')}
            value={note}
            rows={4}
            maxLength={NOTE_MAX}
            counter={`${note.length} / ${NOTE_MAX}`}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex gap-2">
            <Button variant="secondary" disabled={busy !== null} onClick={() => setAsking(false)}>
              {t('cancel')}
            </Button>
            <Button
              loading={busy === 'send-back'}
              disabled={!noteOk || busy !== null}
              onClick={() => void decide('send-back')}
            >
              {t('send-back')}
            </Button>
          </div>
        </section>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-label={t('changes')} className="flex flex-col gap-3">
          <h3 className="text-base font-semibold">
            {post.live === null ? t('changes-new') : t('changes')}
          </h3>
          {changes.length === 0 ? <p className="text-fg-muted">{t('no-changes')}</p> : null}
          {changes.map((change) => (
            <div
              key={change.field}
              className="flex flex-col gap-2 rounded-lg border border-line bg-surface p-4"
            >
              <h4 className="text-sm font-medium">{t(`field.${change.field}`)}</h4>
              <div className="grid gap-2 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-fg-muted">{t('before')}</p>
                  <p className="whitespace-pre-wrap break-words">{change.before ?? t('empty')}</p>
                </div>
                <div>
                  <p className="text-xs text-fg-muted">{t('after')}</p>
                  <p className="whitespace-pre-wrap break-words">{change.after ?? t('removed')}</p>
                </div>
              </div>
            </div>
          ))}
        </section>
        <section
          aria-label={te('checks.title')}
          className="flex flex-col gap-2 self-start rounded-lg border border-line bg-surface p-4"
        >
          <h3 className="text-base font-semibold">{te('checks.title')}</h3>
          {findings === null ? <p className="text-fg-muted">{t('checks-none-run')}</p> : null}
          {findings?.length === 0 ? <p className="text-fg-muted">{te('checks.none')}</p> : null}
          <ul className="flex flex-col gap-2">
            {(findings ?? []).map((finding, index) => (
              <li key={`${finding.code}-${finding.path ?? ''}-${index}`} className="flex gap-2">
                <Badge tone={SEVERITY_TONE[finding.severity]}>
                  {te(`checks.severity.${finding.severity}`)}
                </Badge>
                <span>
                  {te.has(`checks.code.${finding.code}`)
                    ? te(`checks.code.${finding.code}`)
                    : finding.code}
                  {finding.path === null ? '' : ` (${finding.path})`}
                </span>
              </li>
            ))}
          </ul>
          {open !== null && open.decisionNote !== null ? (
            <p className="text-sm text-fg-muted">
              {te('changes-requested', { note: open.decisionNote })}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
