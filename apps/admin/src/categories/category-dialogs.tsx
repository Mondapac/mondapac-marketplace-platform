'use client';

import { Banner, Button, Dialog, Tabs, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import { CategoryProblemBanner } from './category-problem.tsx';
import { ContentFields, SeoFields, useFieldMessage } from './category-form-parts.tsx';
import type { Outcome } from './use-category-call.ts';
import { useCategoryCall } from './use-category-call.ts';
import {
  checkForm,
  checkSlug,
  editBody,
  emptyForm,
  formOf,
  suggestSlug,
  type EditForm,
  type FieldErrors,
} from './edit-model.ts';
import { API_CATEGORIES, SLUG_MAX, type DetailBody, type WriteWrap } from './types.ts';

type FormTab = 'content' | 'seo';

/** The languages of the form: the Market's, then any language the category already has. */
function localesOf(supported: readonly string[], used: readonly string[]): readonly string[] {
  return [...supported, ...used.filter((locale) => !supported.includes(locale))];
}

/** Server field problems folded into the field errors the form shows. */
function mergeErrors(local: FieldErrors, server: FieldErrors): FieldErrors {
  return { ...server, ...local };
}

function Tabbed({
  tab,
  onTab,
  children,
}: {
  readonly tab: FormTab;
  readonly onTab: (tab: FormTab) => void;
  readonly children: React.ReactNode;
}) {
  const t = useTranslations('categories.form');
  return (
    <div className="flex flex-col gap-4">
      <Tabs
        label={t('tabs')}
        items={[
          { id: 'content', label: t('tab-content') },
          { id: 'seo', label: t('tab-seo') },
        ]}
        activeId={tab}
        onSelect={(value) => onTab(value as FormTab)}
      />
      {children}
    </div>
  );
}

/** Edit details: the words per language, the menu switch and the search words. */
export function EditDetailsDialog({
  body,
  supportedLocales,
  csrfToken,
  onClose,
  onSaved,
  onReload,
}: {
  readonly body: DetailBody;
  readonly supportedLocales: readonly string[];
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.form');
  const call = useCategoryCall(csrfToken);
  const [form, setForm] = useState<EditForm>(() => formOf(body.details));
  const locales = useMemo(
    () =>
      localesOf(
        supportedLocales,
        body.details.texts.map((entry) => entry.locale),
      ),
    [supportedLocales, body.details.texts],
  );
  const [active, setActive] = useState(body.requiredLocales[0] ?? locales[0] ?? '');
  const [tab, setTab] = useState<FormTab>('content');
  const [local, setLocal] = useState<FieldErrors>({});
  const errors = mergeErrors(local, call.problem?.fields ?? {});

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = checkForm(form, body.requiredLocales);
    setLocal(found);
    const first = Object.keys(found)[0];
    if (first !== undefined) {
      if (first.startsWith('seo.')) setTab('seo');
      else {
        setTab('content');
        const locale = first.split('.')[1];
        if (locale !== undefined) setActive(locale);
      }
      return;
    }
    const answer: Outcome<WriteWrap> = await call.run<WriteWrap>(
      'PATCH',
      `${API_CATEGORIES}/${body.category.id}`,
      { version: body.category.version, ...editBody(form) },
    );
    if (answer.ok) onSaved();
  }

  const formId = 'category-edit-form';
  const problem = call.problem;
  return (
    <Dialog
      open
      title={t('edit-title')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{t('reload')}</Button>
          ) : (
            <Button type="submit" form={formId} loading={call.pending} disabled={call.pending}>
              {t('save')}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <CategoryProblemBanner problem={problem} />
        <Tabbed tab={tab} onTab={setTab}>
          {tab === 'content' ? (
            <ContentFields
              form={form}
              onChange={setForm}
              errors={errors}
              supported={locales}
              required={body.requiredLocales}
              active={active}
              onActive={setActive}
            />
          ) : (
            <SeoFields
              form={form}
              onChange={setForm}
              errors={errors}
              slug={body.category.slug}
              defaultLocale={body.requiredLocales[0] ?? active}
            />
          )}
        </Tabbed>
      </form>
    </Dialog>
  );
}

/** Add category (a department) or Add child: a new one is created hidden, to be shown later. */
export function CreateCategoryDialog({
  parent,
  parentName,
  treeVersion,
  supportedLocales,
  requiredLocales,
  csrfToken,
  onClose,
  onCreated,
  onReload,
}: {
  /** The id of the parent; null for a department. */
  readonly parent: string | null;
  readonly parentName: string | null;
  readonly treeVersion: number;
  readonly supportedLocales: readonly string[];
  readonly requiredLocales: readonly string[];
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onCreated: (id: string) => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.form');
  const call = useCategoryCall(csrfToken);
  const [form, setForm] = useState<EditForm>(emptyForm());
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [active, setActive] = useState(requiredLocales[0] ?? supportedLocales[0] ?? '');
  const [tab, setTab] = useState<FormTab>('content');
  const [local, setLocal] = useState<FieldErrors>({});
  const errors = mergeErrors(local, call.problem?.fields ?? {});
  const defaultLocale = requiredLocales[0] ?? active;
  const englishName = form.texts['en']?.name ?? form.texts[defaultLocale]?.name ?? '';
  const shownSlug = slugTouched ? slug : suggestSlug(englishName);
  const tm = useFieldMessage(errors);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found: Record<string, string> = { ...checkForm(form, requiredLocales) };
    const slugProblem = checkSlug(shownSlug);
    if (slugProblem !== undefined) found['slug'] = slugProblem;
    setLocal(found);
    const first = Object.keys(found)[0];
    if (first !== undefined) {
      if (first.startsWith('seo.')) setTab('seo');
      else {
        setTab('content');
        const locale = first.startsWith('texts.') ? first.split('.')[1] : undefined;
        if (locale !== undefined) setActive(locale);
      }
      return;
    }
    const answer = await call.run<WriteWrap>('POST', API_CATEGORIES, {
      parentId: parent,
      slug: shownSlug,
      ...editBody(form),
      treeVersion,
    });
    if (answer.ok) onCreated(answer.body.category.id);
  }

  const formId = 'category-create-form';
  const problem = call.problem;
  return (
    <Dialog
      open
      title={
        parent === null ? t('create-title') : t('create-child-title', { parent: parentName ?? '' })
      }
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{t('reload')}</Button>
          ) : (
            <Button type="submit" form={formId} loading={call.pending} disabled={call.pending}>
              {t('create')}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <Banner tone="info">{t('created-hidden')}</Banner>
        <CategoryProblemBanner problem={problem} />
        <Tabbed tab={tab} onTab={setTab}>
          {tab === 'content' ? (
            <>
              <TextField
                name="slug"
                label={t('slug')}
                help={t('slug-help')}
                value={shownSlug}
                dir="ltr"
                lang="en"
                maxLength={SLUG_MAX}
                autoComplete="off"
                error={tm('slug')}
                onChange={(event) => {
                  setSlugTouched(true);
                  setSlug(event.target.value);
                }}
              />
              <ContentFields
                form={form}
                onChange={setForm}
                errors={errors}
                supported={supportedLocales}
                required={requiredLocales}
                active={active}
                onActive={setActive}
              />
            </>
          ) : (
            <SeoFields
              form={form}
              onChange={setForm}
              errors={errors}
              slug={shownSlug}
              defaultLocale={defaultLocale}
            />
          )}
        </Tabbed>
      </form>
    </Dialog>
  );
}

/** Change URL name: the old name keeps working (it redirects), but search engines learn the new one. */
export function ChangeSlugDialog({
  body,
  csrfToken,
  onClose,
  onSaved,
  onReload,
}: {
  readonly body: DetailBody;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onSaved: () => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.form');
  const call = useCategoryCall(csrfToken);
  const [slug, setSlug] = useState(body.category.slug);
  const [local, setLocal] = useState<FieldErrors>({});
  const errors = mergeErrors(local, call.problem?.fields ?? {});
  const message = useFieldMessage(errors);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const problem = checkSlug(slug);
    const unchanged = slug === body.category.slug;
    setLocal(problem === undefined ? (unchanged ? { slug: 'unchanged' } : {}) : { slug: problem });
    if (problem !== undefined || unchanged) return;
    const answer = await call.run<WriteWrap>(
      'POST',
      `${API_CATEGORIES}/${body.category.id}/change-slug`,
      { slug, treeVersion: body.treeVersion },
    );
    if (answer.ok) onSaved();
  }

  const formId = 'category-slug-form';
  const problem = call.problem;
  return (
    <Dialog
      open
      title={t('slug-title')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{t('reload')}</Button>
          ) : (
            <Button type="submit" form={formId} loading={call.pending} disabled={call.pending}>
              {t('slug-save')}
            </Button>
          )}
        </>
      }
    >
      <form
        id={formId}
        className="flex flex-col gap-4"
        onSubmit={(event) => void submit(event)}
        noValidate
      >
        <Banner tone="attention">{t('slug-warning')}</Banner>
        <CategoryProblemBanner problem={problem} />
        <TextField
          name="slug"
          label={t('slug')}
          help={t('slug-help')}
          value={slug}
          dir="ltr"
          lang="en"
          maxLength={SLUG_MAX}
          autoComplete="off"
          error={message('slug')}
          onChange={(event) => setSlug(event.target.value)}
        />
      </form>
    </Dialog>
  );
}

export type ConfirmKind = 'hide' | 'show' | 'discard';

/** Hide, Show or Discard: one question, then one write. Discard focuses Cancel first. */
export function ConfirmCategoryDialog({
  kind,
  body,
  name,
  descendants,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly kind: ConfirmKind;
  readonly body: DetailBody;
  readonly name: string;
  /** How many categories sit below this one. */
  readonly descendants: number;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('categories.confirm');
  const call = useCategoryCall(csrfToken);
  const cancel = useRef<HTMLButtonElement>(null);

  async function confirm() {
    const answer = await call.run<WriteWrap>(
      'POST',
      `${API_CATEGORIES}/${body.category.id}/${kind}`,
      { treeVersion: body.treeVersion },
    );
    if (answer.ok) onDone();
  }

  const problem = call.problem;
  return (
    <Dialog
      open
      title={t(`${kind}.title`, { name })}
      onClose={onClose}
      {...(kind === 'discard' ? { initialFocus: cancel } : {})}
      actions={
        <>
          <Button ref={cancel} variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{t('reload')}</Button>
          ) : (
            <Button
              variant={kind === 'discard' ? 'destructive-solid' : 'primary'}
              loading={call.pending}
              disabled={call.pending}
              onClick={() => void confirm()}
            >
              {t(`${kind}.action`)}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <CategoryProblemBanner problem={problem} />
        <p className="m-0">{t(`${kind}.body`, { name, count: descendants })}</p>
      </div>
    </Dialog>
  );
}
