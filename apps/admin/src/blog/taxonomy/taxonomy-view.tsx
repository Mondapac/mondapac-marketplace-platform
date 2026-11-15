'use client';

import {
  BackLink,
  Banner,
  Button,
  EmptyState,
  LoadError,
  SkeletonRows,
  TextField,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi } from '../../api/client.ts';
import type { Taxonomy } from '../editor/types.ts';
import { API_BLOG_TAXONOMY, BLOG_PATH } from '../types.ts';
import {
  blankCategory,
  SLUG_PATTERN,
  CATEGORY_NAME_MAX,
  categoryBody,
  categoryProblem,
  TAG_NAME_MAX,
  tagBody,
  type CategoryForm,
} from './taxonomy-model.ts';

type Load = 'loading' | 'ready' | 'failed';
type Category = Taxonomy['categories'][number];

const API_CATEGORIES = `${API_BLOG_TAXONOMY}/categories`;
const API_TAGS = `${API_BLOG_TAXONOMY}/tags`;
const TAG_SLUG_OK = (slug: string): boolean =>
  slug.length >= 2 && slug.length <= 40 && SLUG_PATTERN.test(slug);

/** The error key of a refused call, under `blog.taxonomy.error`. */
function errorKey(status: number, code: string): string {
  switch (code) {
    case 'blog.category-slug-taken':
    case 'blog.tag-slug-taken':
      return 'slug-taken';
    case 'blog.category-in-use':
    case 'blog.tag-in-use':
      return 'in-use';
    case 'blog.category-not-found':
    case 'blog.tag-not-found':
      return 'gone';
    case 'validation.failed':
      return 'invalid';
    case 'access.denied':
      return 'denied';
    case 'request.throttled':
      return 'throttled';
    default:
      return status === 0 || status >= 500 ? 'unreachable' : 'unknown';
  }
}

/**
 * The categories and tags of the Market's blog: add a category with a name per language, change
 * its names and order, delete one no post uses; add and delete tags. The address of a category
 * never changes, and a tag's address is made once from its name.
 */
export function TaxonomyView({
  canEdit,
  csrfToken,
}: {
  readonly canEdit: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('blog.taxonomy');
  const locale = useLocale();
  const [load, setLoad] = useState<Load>('loading');
  const [data, setData] = useState<Taxonomy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The category being edited, or 'new'.
  const [editing, setEditing] = useState<string | null>(null);
  const [form, setForm] = useState<CategoryForm>(blankCategory());
  const [formError, setFormError] = useState<string | null>(null);
  const [tagName, setTagName] = useState('');
  const [tagSlug, setTagSlug] = useState('');
  const [confirming, setConfirming] = useState<string | null>(null);
  const [tagSlugBad, setTagSlugBad] = useState(false);
  const formHeading = useRef<HTMLHeadingElement>(null);
  // The button that opened the form, so focus goes back to it when the form closes.
  const opener = useRef<HTMLElement | null>(null);
  const categoriesHeading = useRef<HTMLHeadingElement>(null);
  const tagsHeading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    if (editing !== null) formHeading.current?.focus();
  }, [editing]);

  const fetchAll = useCallback(async () => {
    const result = await callApi<Taxonomy>('GET', API_BLOG_TAXONOMY);
    if (result.ok) {
      setData(result.body);
      setLoad('ready');
    } else if (result.failure.status === 401) {
      window.location.assign('/session-ended');
    } else {
      setLoad('failed');
    }
  }, []);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  /** Runs a write, then reads the lists again; true when it went through. */
  async function write(
    method: 'POST' | 'PUT' | 'DELETE',
    path: string,
    body: unknown,
  ): Promise<boolean> {
    if (busy) return false;
    setBusy(true);
    setError(null);
    const result = await callApi<unknown>(method, path, body, csrfToken);
    if (!result.ok) {
      setBusy(false);
      if (result.failure.status === 401) window.location.assign('/session-ended');
      else {
        const key = errorKey(result.failure.status, result.failure.code);
        setError(key);
        if (key === 'gone') {
          setEditing(null);
          setConfirming(null);
          await fetchAll();
        }
      }
      return false;
    }
    await fetchAll();
    setBusy(false);
    return true;
  }

  if (load === 'loading') return <SkeletonRows label={t('loading')} rows={4} />;
  if (load === 'failed' || data === null) {
    return (
      <LoadError
        className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
        message={t('load-error')}
        retryLabel={t('retry')}
        onRetry={() => {
          setLoad('loading');
          void fetchAll();
        }}
      />
    );
  }

  const locales = data.locales ?? null;
  const defaultLocale = locales?.default ?? '';
  const supported = locales?.supported ?? [];
  const nameOf = (category: Category): string =>
    category.names[locale] ?? category.names[defaultLocale] ?? category.slug;

  function startEdit(category: Category | null, from: HTMLElement | null) {
    opener.current = from;
    setError(null);
    setFormError(null);
    setEditing(category === null ? 'new' : category.id);
    setForm(
      category === null
        ? blankCategory()
        : {
            slug: category.slug,
            // Only the languages the Market supports now; the server refuses any other.
            names: Object.fromEntries(
              Object.entries(category.names).filter(([code]) => supported.includes(code)),
            ),
            position: category.position === undefined ? '' : String(category.position),
          },
    );
  }

  function closeForm() {
    setEditing(null);
    const back = opener.current;
    opener.current = null;
    // The form is gone on the next paint; the opener is still in the list.
    requestAnimationFrame(() => (back?.isConnected ? back : categoriesHeading.current)?.focus());
  }

  async function saveCategory() {
    const isNew = editing === 'new';
    const problem = categoryProblem(form, defaultLocale, isNew);
    if (problem !== null) {
      setFormError(problem);
      return;
    }
    setFormError(null);
    const ok = isNew
      ? await write('POST', API_CATEGORIES, categoryBody(form, true))
      : await write('PUT', `${API_CATEGORIES}/${editing ?? ''}`, categoryBody(form, false));
    if (ok) {
      closeForm();
      toast.success(t(isNew ? 'category-added' : 'category-saved'));
    }
  }

  async function remove(path: string, done: string, heading: 'categories' | 'tags') {
    const ok = await write('DELETE', path, undefined);
    setConfirming(null);
    if (ok) {
      toast.success(t(done));
      (heading === 'tags' ? tagsHeading : categoriesHeading).current?.focus();
    }
  }

  async function addTag() {
    if (tagName.trim() === '') return;
    if (tagSlug.trim() !== '' && !TAG_SLUG_OK(tagSlug.trim())) {
      setTagSlugBad(true);
      return;
    }
    setTagSlugBad(false);
    if (await write('POST', API_TAGS, tagBody(tagName, tagSlug))) {
      setTagName('');
      setTagSlug('');
      toast.success(t('tag-added'));
    }
  }

  const confirmRow = (
    key: string,
    label: string,
    path: string,
    done: string,
    heading: 'categories' | 'tags',
  ) =>
    confirming === key ? (
      <span className="flex flex-wrap items-center gap-2" role="group" aria-label={label}>
        <span className="text-sm">{t('delete-sure', { name: label })}</span>
        <Button
          variant="destructive-solid"
          disabled={busy}
          aria-label={t('delete-confirm-named', { name: label })}
          onClick={() => void remove(path, done, heading)}
        >
          {t('delete-confirm')}
        </Button>
        <Button
          variant="secondary"
          autoFocus
          onClick={() => {
            setConfirming(null);
            requestAnimationFrame(() => document.getElementById(`delete-${key}`)?.focus());
          }}
        >
          {t('cancel')}
        </Button>
      </span>
    ) : (
      <Button
        id={`delete-${key}`}
        variant="secondary"
        disabled={busy || !canEdit}
        aria-label={t('delete-named', { name: label })}
        onClick={() => {
          setError(null);
          setConfirming(key);
        }}
      >
        {t('delete')}
      </Button>
    );

  return (
    <div className="flex flex-col gap-6">
      <BackLink href={BLOG_PATH} label={t('back')} />
      {!canEdit ? <Banner tone="info">{t('read-only')}</Banner> : null}
      {error !== null ? <Banner tone="critical">{t(`error.${error}`)}</Banner> : null}

      <section
        aria-labelledby="categories-title"
        className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2
            id="categories-title"
            ref={categoriesHeading}
            tabIndex={-1}
            className="text-lg font-semibold"
          >
            {t('categories')}
          </h2>
          {canEdit && editing === null ? (
            <Button
              onClick={(event) => startEdit(null, event.currentTarget)}
              disabled={locales === null}
            >
              {t('add-category')}
            </Button>
          ) : null}
        </div>
        {locales === null ? <Banner tone="attention">{t('no-locales')}</Banner> : null}
        {data.categories.length === 0 ? (
          <EmptyState icon="tag" size="compact" title={t('categories-empty')} />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {data.categories.map((category) => (
              <li
                key={category.id}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="flex flex-col">
                  <span className="font-medium">{nameOf(category)}</span>
                  <span className="text-sm text-fg-muted">
                    {category.slug}
                    {category.position === undefined
                      ? ''
                      : ` · ${t('position-value', { n: category.position })}`}
                  </span>
                </div>
                {canEdit ? (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      disabled={busy || locales === null || editing !== null}
                      aria-label={t('edit-named', { name: nameOf(category) })}
                      onClick={(event) => startEdit(category, event.currentTarget)}
                    >
                      {t('edit')}
                    </Button>
                    {confirmRow(
                      category.id,
                      nameOf(category),
                      `${API_CATEGORIES}/${category.id}`,
                      'category-deleted',
                      'categories',
                    )}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {editing !== null && locales !== null ? (
          <form
            className="flex flex-col gap-4 rounded-lg border border-line p-4"
            aria-label={t(editing === 'new' ? 'add-category' : 'edit-category')}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void saveCategory();
            }}
          >
            <h3 ref={formHeading} tabIndex={-1} className="text-base font-semibold">
              {t(editing === 'new' ? 'add-category' : 'edit-category')}
            </h3>
            <TextField
              label={t('slug')}
              help={t(editing === 'new' ? 'slug-help' : 'slug-fixed')}
              value={form.slug}
              dir="ltr"
              maxLength={60}
              disabled={editing !== 'new' || busy}
              error={formError === 'slug' ? t('error.slug-format') : undefined}
              onChange={(event) => setForm({ ...form, slug: event.target.value })}
            />
            {supported.map((code) => (
              <TextField
                key={code}
                label={t('name-in', { locale: code })}
                optionalLabel={code === defaultLocale ? undefined : t('optional')}
                value={form.names[code] ?? ''}
                maxLength={CATEGORY_NAME_MAX}
                disabled={busy}
                error={formError === 'name' && code === defaultLocale ? t('error.name') : undefined}
                onChange={(event) =>
                  setForm({ ...form, names: { ...form.names, [code]: event.target.value } })
                }
              />
            ))}
            <TextField
              label={t('position')}
              optionalLabel={t('optional')}
              help={t('position-help')}
              inputMode="numeric"
              value={form.position}
              disabled={busy}
              error={formError === 'position' ? t('error.position') : undefined}
              onChange={(event) => setForm({ ...form, position: event.target.value })}
            />
            <div className="flex gap-2">
              <Button type="submit" loading={busy}>
                {t('save')}
              </Button>
              <Button variant="secondary" disabled={busy} onClick={closeForm}>
                {t('cancel')}
              </Button>
            </div>
          </form>
        ) : null}
      </section>

      <section
        aria-labelledby="tags-title"
        className="flex flex-col gap-4 rounded-lg border border-line bg-surface p-4"
      >
        <h2 id="tags-title" ref={tagsHeading} tabIndex={-1} className="text-lg font-semibold">
          {t('tags')}
        </h2>
        {data.tags.length === 0 ? (
          <EmptyState icon="tag" size="compact" title={t('tags-empty')} />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {data.tags.map((tag) => (
              <li key={tag.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
                <div className="flex flex-col">
                  <span className="font-medium">{tag.name}</span>
                  <span className="text-sm text-fg-muted">{tag.slug}</span>
                </div>
                {canEdit
                  ? confirmRow(tag.id, tag.name, `${API_TAGS}/${tag.id}`, 'tag-deleted', 'tags')
                  : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <form
            className="flex flex-col gap-4 rounded-lg border border-line p-4"
            aria-label={t('add-tag')}
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              void addTag();
            }}
          >
            <h3 className="text-base font-semibold">{t('add-tag')}</h3>
            <TextField
              label={t('tag-name')}
              value={tagName}
              maxLength={TAG_NAME_MAX}
              disabled={busy}
              onChange={(event) => setTagName(event.target.value)}
            />
            <TextField
              label={t('slug')}
              optionalLabel={t('optional')}
              help={t('tag-slug-help')}
              dir="ltr"
              maxLength={40}
              value={tagSlug}
              disabled={busy}
              error={tagSlugBad ? t('error.slug-format') : undefined}
              onChange={(event) => setTagSlug(event.target.value)}
            />
            <div>
              <Button type="submit" loading={busy} disabled={tagName.trim() === ''}>
                {t('add-tag')}
              </Button>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}
