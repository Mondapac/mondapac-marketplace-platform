'use client';

import {
  Badge,
  Banner,
  BackLink,
  Button,
  CheckboxRow,
  LinkButton,
  LoadError,
  Select,
  SkeletonRows,
  TextAreaField,
  TextField,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import { API_BLOG_POSTS, API_BLOG_TAXONOMY, BLOG_PATH, postPath } from '../types.ts';
import { BlockEditor } from './block-editor.tsx';
import { contentOf, draftOf, isDirty, type Draft } from './editor-model.ts';
import { editorProblemOf, reasonFor, type EditorProblem } from './editor-errors.ts';
import { LIMITS, type ChecksBody, type Finding, type PostDetail, type Taxonomy } from './types.ts';

type Load = 'loading' | 'ready' | 'failed';
const LOCKED: readonly string[] = ['in_review', 'scheduled', 'archived'];
const SEVERITY_TONE = { error: 'critical', warning: 'attention', notice: 'info' } as const;

/**
 * The editor of one post (design A2, text blocks): title, excerpt, body blocks, and the side card
 * with the address, category, tags, cover and search text. Save draft writes the whole content; Send
 * for review saves first and then asks the backend, whose automatic checks may refuse and say why.
 */
export function PostEditor({
  postId,
  canEdit,
  canReview,
  csrfToken,
}: {
  readonly postId: string;
  readonly canEdit: boolean;
  readonly canReview: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('blog.editor');
  const tc = useTranslations('blog');
  const locale = useLocale();
  const [load, setLoad] = useState<Load>('loading');
  const [post, setPost] = useState<PostDetail | null>(null);
  const [taxonomy, setTaxonomy] = useState<Taxonomy | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState<Draft | null>(null);
  const [busy, setBusy] = useState<'save' | 'submit' | 'checks' | null>(null);
  const [problem, setProblem] = useState<EditorProblem | null>(null);
  const [findings, setFindings] = useState<readonly Finding[] | null>(null);
  const working = useRef(false);

  const apply = useCallback((detail: PostDetail) => {
    const version = detail.open ?? detail.live;
    setPost(detail);
    if (version !== null) {
      const next = draftOf(version.content, detail.slug);
      setDraft(next);
      setSaved(next);
    }
  }, []);

  const fetchAll = useCallback(async () => {
    setLoad('loading');
    const [one, tax] = await Promise.all([
      callApi<PostDetail>('GET', `${API_BLOG_POSTS}/${postId}`),
      callApi<Taxonomy>('GET', API_BLOG_TAXONOMY),
    ]);
    for (const result of [one, tax]) {
      if (!result.ok && result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
    }
    if (!one.ok || !tax.ok) {
      setLoad('failed');
      return;
    }
    setTaxonomy(tax.body);
    apply(one.body);
    setLoad('ready');
  }, [postId, apply]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const dirty = draft !== null && saved !== null && isDirty(draft, saved);
  // Leaving with unsaved text asks the browser to confirm.
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  const locked = post === null || LOCKED.includes(post.status);
  const reason = (path: string) => reasonFor(problem, path);
  const categoryLabel = useMemo(
    () => (names: Readonly<Record<string, string>>) =>
      names[locale] ?? names.en ?? Object.values(names)[0] ?? '',
    [locale],
  );

  /** Writes the draft; true when it is saved. */
  async function save(): Promise<boolean> {
    if (draft === null || post === null) return false;
    const result = await callApi<PostDetail>(
      'PUT',
      `${API_BLOG_POSTS}/${postId}/draft`,
      { content: contentOf(draft), slug: draft.slug.trim() },
      csrfToken,
    );
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return false;
      }
      const next = editorProblemOf(result.failure);
      setProblem(next);
      if (next.reload) void fetchAll();
      return false;
    }
    setProblem(null);
    apply(result.body);
    return true;
  }

  async function onSave() {
    if (working.current) return;
    working.current = true;
    setBusy('save');
    setFindings(null);
    const ok = await save();
    working.current = false;
    setBusy(null);
    if (ok) toast.success(t('saved-toast'));
  }

  async function onSubmit() {
    if (working.current || post === null) return;
    working.current = true;
    setBusy('submit');
    setFindings(null);
    const ok = !dirty || (await save());
    if (ok) {
      const result = await callApi<PostDetail>(
        'POST',
        `${API_BLOG_POSTS}/${postId}/submit`,
        undefined,
        csrfToken,
      );
      if (result.ok) {
        setProblem(null);
        apply(result.body);
        toast.success(t('submitted-toast'));
      } else if (result.failure.status === 401) {
        window.location.assign('/session-ended');
      } else {
        const next = editorProblemOf(result.failure);
        setProblem(next);
        if (next.findings.length > 0) setFindings(next.findings);
        if (next.reload) void fetchAll();
      }
    }
    working.current = false;
    setBusy(null);
  }

  async function onChecks() {
    if (working.current) return;
    working.current = true;
    setBusy('checks');
    const result = await callApi<ChecksBody>('GET', `${API_BLOG_POSTS}/${postId}/checks`);
    working.current = false;
    setBusy(null);
    if (!result.ok) {
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else setProblem(editorProblemOf(result.failure));
      return;
    }
    setProblem(null);
    setFindings(result.body.findings);
  }

  if (load === 'loading') return <SkeletonRows label={t('loading')} rows={5} />;
  if (load === 'failed' || post === null || draft === null || taxonomy === null) {
    return (
      <LoadError
        className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
        message={t('load-error')}
        retryLabel={t('retry')}
        onRetry={() => void fetchAll()}
      />
    );
  }

  const version = post.open ?? post.live;
  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const disabled = locked || !canEdit || busy !== null;
  const note = post.open?.decisionNote;

  return (
    <div className="flex flex-col gap-4">
      <BackLink href={BLOG_PATH} label={t('back')} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <Badge tone={post.status === 'published' ? 'success' : 'neutral'}>
            {tc(`state.${post.status}`)}
          </Badge>
          <span className="text-sm text-fg-muted">
            {version === null ? '' : t('version', { n: version.versionNo })}
          </span>
          <span role="status" className="text-sm text-fg-muted">
            {dirty ? t('unsaved') : t('all-saved')}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {canReview ? (
            <Button
              variant="secondary"
              loading={busy === 'checks'}
              disabled={disabled || post.open === null || dirty}
              onClick={() => void onChecks()}
            >
              {t('run-checks')}
            </Button>
          ) : null}
          <Button
            variant="secondary"
            loading={busy === 'save'}
            disabled={disabled || !dirty}
            onClick={() => void onSave()}
          >
            {t('save')}
          </Button>
          <Button
            loading={busy === 'submit'}
            disabled={disabled || (post.open === null && !dirty)}
            onClick={() => void onSubmit()}
          >
            {t('submit')}
          </Button>
        </div>
      </div>
      {canReview && post.status === 'in_review' ? (
        <Banner tone="info">
          <LinkButton variant="secondary" href={`${postPath(postId)}/review`}>
            {t('go-review')}
          </LinkButton>
        </Banner>
      ) : null}
      {!canEdit ? <Banner tone="info">{t('read-only')}</Banner> : null}
      {locked ? <Banner tone="info">{t(`locked.${post.status}`)}</Banner> : null}
      {post.open?.editedByReviewer ? <Banner tone="info">{t('edited-by-reviewer')}</Banner> : null}
      {note ? <Banner tone="attention">{t('changes-requested', { note })}</Banner> : null}
      {problem !== null ? (
        <Banner tone="critical">
          <span>{t(problem.key.replace('blog.editor.', ''))}</span>
        </Banner>
      ) : null}
      {findings !== null ? (
        <section
          aria-label={t('checks.title')}
          className="rounded-lg border border-line bg-surface p-4"
        >
          <h2 className="mb-2 text-base font-semibold">{t('checks.title')}</h2>
          {findings.length === 0 ? (
            <p className="text-fg-muted">{t('checks.none')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {findings.map((finding, index) => (
                <li key={`${finding.code}-${finding.path ?? ''}-${index}`} className="flex gap-2">
                  <Badge tone={SEVERITY_TONE[finding.severity]}>
                    {t(`checks.severity.${finding.severity}`)}
                  </Badge>
                  <span>
                    {t.has(`checks.code.${finding.code}`)
                      ? t(`checks.code.${finding.code}`)
                      : finding.code}
                    {finding.path === null ? '' : ` (${finding.path})`}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <TextField
            label={t('field.title')}
            value={draft.title}
            maxLength={LIMITS.title}
            disabled={disabled}
            error={reason('content.title') === undefined ? undefined : t('field.invalid')}
            onChange={(event) => set({ title: event.target.value })}
          />
          <TextAreaField
            label={t('field.excerpt')}
            help={t('field.excerpt-help')}
            value={draft.excerpt}
            rows={2}
            maxLength={LIMITS.excerpt}
            disabled={disabled}
            counter={`${draft.excerpt.length} / ${LIMITS.excerpt}`}
            onChange={(event) => set({ excerpt: event.target.value })}
          />
          <BlockEditor
            blocks={draft.blocks}
            disabled={disabled}
            reasonAt={reason}
            onChange={(blocks) => set({ blocks })}
          />
        </div>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-base font-semibold">{t('side.post')}</h2>
            <p className="text-sm text-fg-muted">
              {t('side.type')}: {tc(`kind.${post.kind}`)}
            </p>
            <TextField
              label={t('field.slug')}
              help={t('field.slug-help')}
              value={draft.slug}
              disabled={disabled}
              error={
                reason('slug') === undefined
                  ? undefined
                  : t(
                      problem?.key === 'blog.editor.error.slug-taken'
                        ? 'field.slug-taken'
                        : 'field.invalid',
                    )
              }
              onChange={(event) => set({ slug: event.target.value })}
            />
            <Select
              label={t('field.category')}
              value={draft.categoryId}
              disabled={disabled}
              options={[
                { value: '', label: t('field.none') },
                ...taxonomy.categories.map((c) => ({ value: c.id, label: categoryLabel(c.names) })),
              ]}
              onChange={(event) => set({ categoryId: event.target.value })}
            />
            {post.ownerType === 'platform' ? (
              <TextField
                label={t('field.author')}
                optionalLabel={t('optional')}
                help={t('field.author-help')}
                value={draft.authorDisplay}
                maxLength={LIMITS.authorDisplay}
                disabled={disabled}
                onChange={(event) => set({ authorDisplay: event.target.value })}
              />
            ) : null}
            <fieldset className="flex flex-col gap-1">
              <legend className="mb-1 text-sm font-medium">
                {t('field.tags', { max: LIMITS.tags })}
              </legend>
              {taxonomy.tags.length === 0 ? (
                <p className="text-sm text-fg-muted">{t('field.tags-none')}</p>
              ) : null}
              {taxonomy.tags.map((tag) => {
                const on = draft.tagIds.includes(tag.id);
                return (
                  <CheckboxRow
                    key={tag.id}
                    label={tag.name}
                    checked={on}
                    disabled={disabled || (!on && draft.tagIds.length >= LIMITS.tags)}
                    onChange={() =>
                      set({
                        tagIds: on
                          ? draft.tagIds.filter((id) => id !== tag.id)
                          : [...draft.tagIds, tag.id],
                      })
                    }
                  />
                );
              })}
            </fieldset>
          </div>
          <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-base font-semibold">{t('side.cover')}</h2>
            <TextField
              label={t('field.cover-id')}
              help={t('field.cover-help')}
              value={draft.coverImageId}
              disabled={disabled}
              error={reason('content.coverImageId') === undefined ? undefined : t('field.invalid')}
              onChange={(event) => set({ coverImageId: event.target.value })}
            />
            <TextField
              label={t('field.cover-alt')}
              value={draft.coverAlt}
              maxLength={LIMITS.coverAlt}
              disabled={disabled}
              onChange={(event) => set({ coverAlt: event.target.value })}
            />
          </div>
          <div className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4">
            <h2 className="text-base font-semibold">{t('side.seo')}</h2>
            <p className="text-sm text-fg-muted">{t('field.seo-help')}</p>
            <TextField
              label={t('field.seo-title')}
              optionalLabel={t('optional')}
              value={draft.seoTitle}
              maxLength={LIMITS.seoTitle}
              disabled={disabled}
              onChange={(event) => set({ seoTitle: event.target.value })}
            />
            <TextAreaField
              label={t('field.seo-description')}
              optionalLabel={t('optional')}
              value={draft.seoDescription}
              rows={3}
              maxLength={LIMITS.seoDescription}
              disabled={disabled}
              counter={`${draft.seoDescription.length} / ${LIMITS.seoDescription}`}
              onChange={(event) => set({ seoDescription: event.target.value })}
            />
          </div>
          {post.kind === 'event' ? <Banner tone="info">{t('event-later')}</Banner> : null}
        </div>
      </div>
    </div>
  );
}
