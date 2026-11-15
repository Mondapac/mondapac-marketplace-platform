'use client';

import {
  Banner,
  Button,
  Card,
  FormActionBar,
  Select,
  TextAreaField,
  TextField,
  toast,
  useUnsavedChangesGuard,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../../api/client.ts';
import { shortInstantInZone } from '../../shared/format.ts';
import { instantToLocal, localToInstant } from '../slides/zone-time.ts';
import { ImageInputs } from './module-form.tsx';
import { PageActions } from './page-actions.tsx';
import { PageEditorHeader } from './page-editor-header.tsx';
import {
  CATALOGUE_API_PATH,
  SLUG_MAX,
  TITLE_MAX,
  detailRef,
  isReadOnlyPage,
  pageApiPath,
  type Catalogue,
  type PageDetail,
} from './page-types.ts';
import {
  SEO_DESCRIPTION_MAX,
  SEO_TITLE_MAX,
  formOf,
  mapProblems,
  requestOf,
  sameForm,
  sourceOf,
  validate,
  type SettingsCode,
  type SettingsErrors,
  type SettingsField,
  type SettingsForm,
} from './settings-form.ts';
import { usePageCommand, useProblemText } from './use-page-command.ts';

const CATEGORIES_API_PATH = 'catalog/admin/categories';

interface CategoryOption {
  readonly id: string;
  readonly label: string;
}
interface CategoryTree {
  readonly defaultLocale: string;
  readonly categories: readonly {
    readonly id: string;
    readonly status: string;
    readonly depth: number;
    readonly names: readonly { readonly locale: string; readonly name: string }[];
  }[];
}

/** "24 / 70" under a field, in the critical colour once the text is too long. */
function Counter({ value, max }: { readonly value: string; readonly max: number }) {
  const t = useTranslations('content.pages.settings');
  const count = [...value.trim()].length;
  const over = count > max;
  return (
    <span className={`shrink-0 whitespace-nowrap ${over ? 'text-critical-fg' : ''}`}>
      {t('counter', { count, max })}
      {over ? <span className="sr-only"> {t('over', { n: count - max })}</span> : null}
    </span>
  );
}

/**
 * The Settings tab of the page editor: title, address, linked category, live window and the SEO
 * fields of a landing page; title and SEO of a system page. Save writes the draft: buyers keep
 * seeing the settings below ("What buyers see now") until a platform admin publishes. Without
 * the edit key (or on an archived or locked page) the form is read-only.
 */
export function PageSettings({
  page: initial,
  canEdit,
  canPublish = false,
  canArchive = false,
  csrfToken,
  zone,
}: {
  readonly page: PageDetail;
  readonly canEdit: boolean;
  readonly canPublish?: boolean;
  readonly canArchive?: boolean;
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations('content.pages.settings');
  const te = useTranslations('content.pages.editor');
  const locale = useLocale();
  const problemText = useProblemText();
  const command = usePageCommand(csrfToken);
  const formRef = useRef<HTMLFormElement>(null);
  const [page, setPage] = useState(initial);
  const toLocal = (instant: string) => instantToLocal(instant, zone);
  const [baseline, setBaseline] = useState<SettingsForm>(() => formOf(initial, toLocal));
  const [form, setForm] = useState<SettingsForm>(baseline);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [taken, setTaken] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [categories, setCategories] = useState<readonly CategoryOption[]>([]);
  const [linkable, setLinkable] = useState(false);

  const dynamic = page.kind === 'dynamic';
  const readOnly = isReadOnlyPage(page, canEdit);
  const dirty = !sameForm(form, baseline);
  const ref = detailRef(page);
  const keptLink = sourceOf(page).linked;

  // The template says whether a category may be linked; the lookup is a courtesy: without it
  // (no permission) the link is left as it is.
  useEffect(() => {
    if (!dynamic) return;
    let live = true;
    void (async () => {
      const catalogue = await callApi<Catalogue>('GET', CATALOGUE_API_PATH);
      if (!live || !catalogue.ok) return;
      const can = catalogue.body.templates
        .find((template) => template.key === initial.templateKey)
        ?.linkable.includes('category');
      if (can !== true) return;
      setLinkable(true);
      const tree = await callApi<CategoryTree>('GET', CATEGORIES_API_PATH);
      if (!live || !tree.ok) return;
      setCategories(
        tree.body.categories
          .filter((category) => category.status === 'active')
          .map((category) => {
            const name =
              category.names.find((entry) => entry.locale === tree.body.defaultLocale) ??
              category.names[0];
            return {
              id: category.id,
              label: `${'– '.repeat(category.depth)}${name?.name ?? category.id}`,
            };
          }),
      );
    })();
    return () => {
      live = false;
    };
  }, [dynamic, initial.templateKey]);

  const guard = useUnsavedChangesGuard(dirty, {
    title: t('leave.title'),
    message: t('leave.message', { title: page.title }),
    stay: t('leave.stay'),
    leave: t('leave.leave'),
    destructive: true,
  });

  // After a refused save the first marked field takes focus, so the reason is read at once.
  useEffect(() => {
    if (focusRequest === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  function change(patch: Partial<SettingsForm>, ...fields: SettingsField[]) {
    setForm((previous) => ({ ...previous, ...patch }));
    if (fields.length > 0) {
      setErrors((previous) => {
        const next = { ...previous };
        for (const field of fields) delete next[field];
        return next;
      });
    }
  }

  function messageFor(field: SettingsField, code: SettingsCode): string {
    if (field === 'title' && code === 'too-long')
      return t('error.title-too-long', { max: TITLE_MAX });
    if (field === 'slug' && code === 'format') return t('error.slug-format', { max: SLUG_MAX });
    if (field === 'seoTitle' && code === 'too-long') {
      return t('error.too-long', { max: SEO_TITLE_MAX });
    }
    if (field === 'seoDescription' && code === 'too-long') {
      return t('error.too-long', { max: SEO_DESCRIPTION_MAX });
    }
    const key = `error.${field}-${code}`;
    return t.has(key) ? t(key) : t('error.invalid');
  }
  const errorOf = (field: SettingsField): string | undefined => {
    const code = errors[field];
    return code === undefined ? undefined : messageFor(field, code);
  };

  function failWith(found: SettingsErrors) {
    setErrors(found);
    setSummary(t('error.summary'));
    setFocusRequest((n) => n + 1);
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (readOnly) return;
    setSummary(null);
    const found = validate(form, dynamic);
    if (taken !== null && taken === form.slug) found.slug = 'taken';
    if (Object.keys(found).length > 0) {
      failWith(found);
      return;
    }
    const startsAt = form.startsAt === '' ? null : localToInstant(form.startsAt, zone);
    const endsAt = form.endsAt === '' ? null : localToInstant(form.endsAt, zone);
    if ((form.startsAt !== '' && startsAt === null) || (form.endsAt !== '' && endsAt === null)) {
      failWith({ [form.startsAt !== '' && startsAt === null ? 'startsAt' : 'endsAt']: 'invalid' });
      return;
    }
    setErrors({});
    const result = await command.run(
      'PUT',
      pageApiPath(ref),
      requestOf(form, page, (local) => localToInstant(local, zone), toLocal),
    );
    if (result === null) return;
    if (result.ok) {
      const saved = formOf(result.page, toLocal);
      setPage(result.page);
      setBaseline(saved);
      setForm(saved);
      toast.success(t('saved'));
      return;
    }
    // Fields the API refused are marked; any other refusal is worded above the form.
    const problem = result.problem;
    if (problem.code === 'storefront.slug-taken') {
      setTaken(form.slug);
      failWith({ slug: 'taken' });
    } else if (problem.code === 'validation.failed') {
      const mapped = mapProblems(problem.fields);
      if (Object.keys(mapped.fields).length > 0) failWith(mapped.fields);
      else setSummary(problemText(problem));
    } else {
      setSummary(problemText(problem));
    }
  }

  const slugChanged =
    dynamic && page.publishedVersionNo !== null && page.slug !== null && form.slug !== page.slug;
  const live = page;

  return (
    <div className="flex flex-col gap-4">
      <PageEditorHeader
        page={page}
        tab="settings"
        zone={zone}
        canEdit={canEdit}
        actions={
          <PageActions
            page={page}
            canPublish={canPublish}
            canArchive={canArchive}
            csrfToken={csrfToken}
          />
        }
      />
      {guard.dialog}
      <div className="grid min-w-0 gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <form
          ref={formRef}
          aria-label={t('form')}
          noValidate
          onSubmit={(event) => void save(event)}
          className="flex min-w-0 flex-col gap-4"
        >
          {summary === null ? null : <Banner tone="critical">{summary}</Banner>}
          {page.draft.settings === null ? null : <Banner tone="info">{t('pending')}</Banner>}
          <fieldset
            disabled={readOnly || command.pending}
            className="m-0 flex min-w-0 flex-col gap-5 rounded-lg border border-line bg-surface p-4 sm:p-6"
          >
            <legend className="sr-only">{t('page-group')}</legend>
            <TextField
              label={t('name')}
              value={form.title}
              autoComplete="off"
              error={errorOf('title')}
              help={t('name-help', { max: TITLE_MAX })}
              onChange={(event) => change({ title: event.target.value }, 'title')}
            />
            {dynamic ? (
              <>
                <TextField
                  label={t('slug')}
                  value={form.slug}
                  autoComplete="off"
                  autoCapitalize="none"
                  spellCheck={false}
                  dir="ltr"
                  prefix="/l/"
                  error={errorOf('slug')}
                  help={t('slug-help', { max: SLUG_MAX })}
                  onChange={(event) => {
                    setTaken(null);
                    change({ slug: event.target.value }, 'slug');
                  }}
                />
                {slugChanged ? <Banner tone="attention">{t('slug-redirect')}</Banner> : null}
                {linkable && categories.length > 0 ? (
                  <Select
                    label={t('linked')}
                    value={form.linkedId}
                    placeholder={t('linked-none')}
                    help={t('linked-help')}
                    error={errorOf('linkedId')}
                    options={categories.map((category) => ({
                      value: category.id,
                      label: category.label,
                    }))}
                    onChange={(event) => change({ linkedId: event.target.value }, 'linkedId')}
                  />
                ) : keptLink != null && keptLink.type !== 'category' ? (
                  <p className="text-sm text-fg-muted">
                    {t('linked-other', { type: keptLink.type })}
                  </p>
                ) : null}
                <div className="grid gap-5 sm:grid-cols-2">
                  <TextField
                    label={t('starts')}
                    type="datetime-local"
                    value={form.startsAt}
                    error={errorOf('startsAt')}
                    help={t('window-help', { zone })}
                    onChange={(event) =>
                      change({ startsAt: event.target.value }, 'startsAt', 'endsAt')
                    }
                  />
                  <TextField
                    label={t('ends')}
                    type="datetime-local"
                    value={form.endsAt}
                    error={errorOf('endsAt')}
                    onChange={(event) => change({ endsAt: event.target.value }, 'endsAt')}
                  />
                </div>
              </>
            ) : null}
            <TextField
              label={t('seo-title')}
              value={form.seoTitle}
              autoComplete="off"
              optionalLabel={te('optional')}
              error={errorOf('seoTitle')}
              help={
                <span className="flex justify-between gap-3">
                  <span>{t('seo-title-help')}</span>
                  <Counter value={form.seoTitle} max={SEO_TITLE_MAX} />
                </span>
              }
              onChange={(event) => change({ seoTitle: event.target.value }, 'seoTitle')}
            />
            <TextAreaField
              label={t('seo-description')}
              value={form.seoDescription}
              rows={3}
              optionalLabel={te('optional')}
              error={errorOf('seoDescription')}
              help={t('seo-description-help')}
              counter={<Counter value={form.seoDescription} max={SEO_DESCRIPTION_MAX} />}
              onChange={(event) => change({ seoDescription: event.target.value }, 'seoDescription')}
            />
            <ImageInputs
              legend={t('seo-image')}
              optional
              image={form.image}
              refError={errorOf('imageRef')}
              altError={errorOf('imageAlt')}
              onChange={(image) => change({ image }, 'imageRef', 'imageAlt')}
            />
            <p className="text-sm text-fg-muted">{t('seo-elsewhere')}</p>
          </fieldset>
          {readOnly ? null : (
            <FormActionBar status={<span className="block">{t('draft-note')}</span>}>
              <Button
                variant="secondary"
                disabled={!dirty || command.pending}
                onClick={() => {
                  setForm(baseline);
                  setErrors({});
                  setSummary(null);
                }}
              >
                {t('discard')}
              </Button>
              <Button type="submit" loading={command.pending} disabled={!dirty}>
                {t('save-draft')}
              </Button>
            </FormActionBar>
          )}
        </form>
        <aside aria-label={t('now')} className="min-w-0">
          <Card title={t('now')}>
            <dl className="m-0 flex flex-col gap-2 text-sm">
              <Row label={t('name')} value={live.title} />
              <Row label={dynamic ? t('slug') : t('address')} value={live.path} code />
              {dynamic ? (
                <>
                  <Row label={t('starts')} value={windowText(live.startsAt, t('none'))} />
                  <Row label={t('ends')} value={windowText(live.endsAt, t('none'))} />
                </>
              ) : null}
              <Row label={t('seo-title')} value={live.seo.title ?? t('none')} />
              <Row label={t('seo-description')} value={live.seo.description ?? t('none')} />
              <Row
                label={t('status')}
                value={
                  live.publishedAt === null
                    ? t('never-published')
                    : t('published-on', {
                        when: shortInstantInZone(live.publishedAt, locale, zone),
                      })
                }
              />
            </dl>
            <p className="text-sm text-fg-muted">{t('now-note')}</p>
          </Card>
        </aside>
      </div>
    </div>
  );

  function windowText(instant: string | null, none: string): string {
    return instant === null ? none : shortInstantInZone(instant, locale, zone);
  }
}

function Row({
  label,
  value,
  code = false,
}: {
  readonly label: string;
  readonly value: string;
  readonly code?: boolean;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="m-0 break-words text-fg">
        {code ? <code className="text-xs">{value}</code> : value}
      </dd>
    </div>
  );
}
