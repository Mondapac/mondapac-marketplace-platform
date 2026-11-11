'use client';

import {
  BackLink,
  Banner,
  Button,
  FormActionBar,
  LoadError,
  Select,
  SkeletonRows,
  TextField,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { callApi } from '../../api/client.ts';
import { localToInstant } from '../slides/zone-time.ts';
import {
  EMPTY_FORM,
  mapProblems,
  requestOf,
  sameForm,
  slugOf,
  validate,
  type FieldCode,
  type FieldErrors,
  type FormField,
  type NewPageForm,
} from './page-form.ts';
import {
  CATALOGUE_API_PATH,
  DYNAMIC_TEMPLATES,
  PAGES_API_PATH,
  PAGES_PATH,
  SLUG_MAX,
  TITLE_MAX,
  pagePath,
  type Catalogue,
  type DynamicTemplate,
} from './page-types.ts';

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

type Load = 'loading' | 'ready' | 'failed';
type Problem = string | null;

/**
 * "New page": a template, a title, the address, what the page is linked to and when it is live.
 * The draft starts with the template's default modules and buyers see nothing until a platform
 * admin publishes it. v1 links categories only (the product and seller lookups do not exist), so
 * the product spotlight template, which links products only, is not offered.
 */
export function NewPageFormView({
  csrfToken,
  zone,
}: {
  readonly csrfToken: string;
  /** The IANA zone the live window is typed on. */
  readonly zone: string;
}) {
  const t = useTranslations('content.pages.new');
  const templates = useTranslations('content.pages.template');
  const tl = useTranslations('load');
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const inFlight = useRef(false);
  const [load, setLoad] = useState<Load>('loading');
  const [linkable, setLinkable] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [categories, setCategories] = useState<readonly CategoryOption[]>([]);
  const [form, setForm] = useState<NewPageForm>(EMPTY_FORM);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [taken, setTaken] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem>(null);
  const [pending, setPending] = useState(false);
  const [focusRequest, setFocusRequest] = useState(0);
  const dirty = !sameForm(form, EMPTY_FORM);

  const fetchCatalogue = useCallback(async () => {
    setLoad('loading');
    const result = await callApi<Catalogue>('GET', CATALOGUE_API_PATH);
    if (!result.ok) {
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      setLoad('failed');
      return;
    }
    setLinkable(
      new Map(
        result.body.templates.map((template) => [
          template.key,
          template.linkable.includes('category'),
        ]),
      ),
    );
    setLoad('ready');
    // The category lookup is a courtesy: without it (no permission) the page is created unlinked.
    const tree = await callApi<CategoryTree>('GET', CATEGORIES_API_PATH);
    if (tree.ok) {
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
    }
  }, []);

  useEffect(() => {
    void fetchCatalogue();
  }, [fetchCatalogue]);

  // Leaving with typed values asks first.
  useEffect(() => {
    if (!dirty) return;
    const guard = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', guard);
    return () => window.removeEventListener('beforeunload', guard);
  }, [dirty]);

  // After a refused save the first marked field takes focus, so the reason is read at once.
  useEffect(() => {
    if (focusRequest === 0) return;
    formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [focusRequest]);

  function change(patch: Partial<NewPageForm>, ...fields: FormField[]) {
    setForm((previous) => ({ ...previous, ...patch }));
    if (fields.length > 0) {
      setErrors((previous) => {
        const next = { ...previous };
        for (const field of fields) delete next[field];
        return next;
      });
    }
  }

  function messageFor(field: FormField, code: FieldCode): string {
    if (field === 'slug' && code === 'taken') return t('error.slug-taken');
    if (field === 'title' && code === 'too-long')
      return t('error.title-too-long', { max: TITLE_MAX });
    if (field === 'slug' && code === 'format') return t('error.slug-format', { max: SLUG_MAX });
    const key = `error.${field}-${code}`;
    return t.has(key) ? t(key) : t('error.summary');
  }
  const errorOf = (field: FormField): string | undefined => {
    const code = errors[field];
    return code === undefined ? undefined : messageFor(field, code);
  };

  function failWith(found: FieldErrors) {
    setErrors(found);
    setProblem(t('error.summary'));
    setFocusRequest((n) => n + 1);
  }

  async function save(event?: FormEvent) {
    event?.preventDefault();
    if (inFlight.current) return;
    setProblem(null);
    const found = validate(form);
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
    inFlight.current = true;
    setPending(true);
    try {
      const result = await callApi<{ readonly id: string | null }>(
        'POST',
        PAGES_API_PATH,
        requestOf(form, (local) => localToInstant(local, zone)),
        csrfToken,
      );
      if (result.ok) {
        toast.flash('success', t('created'));
        router.push(result.body.id === null ? PAGES_PATH : pagePath(result.body.id));
        return;
      }
      const failure = result.failure;
      if (failure.status === 401) {
        router.replace('/session-ended');
        return;
      }
      if (failure.code === 'storefront.slug-taken') {
        setTaken(form.slug);
        failWith({ slug: 'taken' });
        return;
      }
      if (failure.code === 'validation.failed') {
        const mapped = mapProblems(failure.details?.fields ?? []);
        if (Object.keys(mapped.fields).length > 0) failWith(mapped.fields);
        else setProblem(t('error.generic'));
        return;
      }
      setProblem(
        failure.code === 'network'
          ? t('error.network')
          : failure.status === 403
            ? t('error.denied')
            : t('error.generic'),
      );
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  }

  const offered = DYNAMIC_TEMPLATES.filter((key) => key !== 'product-spotlight');
  const canLink =
    form.template !== '' && linkable.get(form.template) === true && categories.length > 0;

  return (
    <div className="flex flex-col gap-4">
      <BackLink href={PAGES_PATH} label={t('back')} />
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-fg-muted">{t('intro')}</p>
      </div>
      {load === 'loading' ? <SkeletonRows label={t('loading')} rows={4} /> : null}
      {load === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
          message={t('error.load')}
          retryLabel={tl('retry')}
          onRetry={() => void fetchCatalogue()}
        />
      ) : null}
      {load === 'ready' ? (
        <form
          ref={formRef}
          aria-label={t('form')}
          noValidate
          onSubmit={(event) => void save(event)}
          className="flex min-w-0 flex-col gap-4"
        >
          {problem === null ? null : <Banner tone="critical">{problem}</Banner>}
          <fieldset
            disabled={pending}
            className="m-0 flex min-w-0 flex-col gap-5 rounded-lg border border-line bg-surface p-4 sm:p-6"
          >
            <fieldset
              className="m-0 min-w-0 border-0 p-0 @container"
              aria-describedby={errors.template === undefined ? undefined : 'template-error'}
            >
              <legend className="mb-1.5 p-0 text-sm font-medium text-fg">{t('template')}</legend>
              <div className="grid gap-3 @lg:grid-cols-2">
                {offered.map((key: DynamicTemplate) => (
                  <label
                    key={key}
                    className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border border-line-input bg-surface p-3 has-checked:border-accent has-checked:bg-selected has-focus-visible:outline-2 has-focus-visible:outline-focus"
                  >
                    <input
                      type="radio"
                      name="page-template"
                      value={key}
                      checked={form.template === key}
                      onChange={() =>
                        change(
                          {
                            template: key,
                            linkedId: linkable.get(key) === true ? form.linkedId : '',
                          },
                          'template',
                        )
                      }
                      className="mt-1 size-4 shrink-0 accent-accent"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-fg">{templates(key)}</span>
                      <span className="block text-sm text-fg-muted">
                        {templates(`${key}-help`)}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
              {errors.template === undefined ? null : (
                <p id="template-error" role="alert" className="mt-1.5 text-sm text-critical-fg">
                  {errorOf('template')}
                </p>
              )}
            </fieldset>
            <TextField
              label={t('name')}
              value={form.title}
              autoComplete="off"
              error={errorOf('title')}
              help={t('name-help', { max: TITLE_MAX })}
              onChange={(event) => {
                const title = event.target.value;
                change(
                  { title, ...(form.slugEdited ? {} : { slug: slugOf(title) }) },
                  'title',
                  ...(form.slugEdited ? [] : (['slug'] as const)),
                );
              }}
            />
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
                change({ slug: event.target.value, slugEdited: true }, 'slug');
              }}
            />
            {canLink ? (
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
            ) : null}
            <div className="grid gap-5 sm:grid-cols-2">
              <TextField
                label={t('starts')}
                type="datetime-local"
                value={form.startsAt}
                error={errorOf('startsAt')}
                help={t('window-help', { zone })}
                onChange={(event) => change({ startsAt: event.target.value }, 'startsAt', 'endsAt')}
              />
              <TextField
                label={t('ends')}
                type="datetime-local"
                value={form.endsAt}
                error={errorOf('endsAt')}
                onChange={(event) => change({ endsAt: event.target.value }, 'endsAt')}
              />
            </div>
          </fieldset>
          <FormActionBar status={<span className="block">{t('draft-note')}</span>}>
            <Button variant="secondary" disabled={pending} onClick={() => router.push(PAGES_PATH)}>
              {t('cancel')}
            </Button>
            <Button type="submit" loading={pending}>
              {t('create')}
            </Button>
          </FormActionBar>
        </form>
      ) : null}
    </div>
  );
}
