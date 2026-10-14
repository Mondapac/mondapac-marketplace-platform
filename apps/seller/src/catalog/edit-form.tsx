'use client';

import { Banner, Button, Card, CheckboxRow, TextField } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { callApi } from '../api/client.ts';
import { editProblemOf, type EditProblem } from './edit-errors.ts';
import type { DraftSaved, ProductView, Submitted } from './types.ts';

const KEYS = ['name', 'shortDescription', 'description'] as const;
type TextKey = (typeof KEYS)[number];
type Texts = Record<string, Record<TextKey, string>>;

function textsOf(
  content: Readonly<Record<string, unknown>> | undefined,
  locales: readonly string[],
): Texts {
  const stored = (content?.['texts'] ?? {}) as Record<string, Record<string, unknown> | undefined>;
  return Object.fromEntries(
    locales.map((locale) => [
      locale,
      Object.fromEntries(
        KEYS.map((key) => {
          const value = stored[locale]?.[key];
          return [key, typeof value === 'string' ? value : ''];
        }),
      ) as Record<TextKey, string>,
    ]),
  );
}

/** The saved content with only `texts` replaced: every other key of the draft is sent back as it was. */
export function contentWith(
  content: Readonly<Record<string, unknown>> | undefined,
  texts: Texts,
): Record<string, unknown> {
  const next: Record<string, Record<string, string>> = {};
  for (const [locale, entry] of Object.entries(texts)) {
    const kept = Object.fromEntries(
      KEYS.map((key) => [key, entry[key].trim()] as const).filter(([, value]) => value !== ''),
    );
    if (Object.keys(kept).length > 0) next[locale] = kept;
  }
  return { ...(content ?? {}), texts: next };
}

export function EditForm({
  product,
  locales,
  csrfToken,
}: {
  readonly product: ProductView;
  readonly locales: readonly string[];
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const router = useRouter();
  const [content, setContent] = useState(product.workingCopy?.content);
  const [texts, setTexts] = useState<Texts>(() => textsOf(content, locales));
  const [dirty, setDirty] = useState(false);
  const [replacePending, setReplacePending] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<EditProblem | null>(null);
  const [refused, setRefused] = useState<DraftSaved['refusedFields']>([]);
  const [notice, setNotice] = useState<'saved' | 'submitted' | 'published' | null>(null);
  const busy = useRef(false);

  const variantIds = product.variants
    .filter((variant) => variant.state !== 'retired')
    .map((variant) => variant.variantId);
  const base = `catalog/seller/products/${product.productId}`;

  function fail(failure: Parameters<typeof editProblemOf>[0]) {
    if (failure.status === 401) window.location.assign('/session-ended');
    else setProblem(editProblemOf(failure));
  }

  /** Saves the texts; 'saved' when the API took the draft whole, 'refused' when it dropped some texts. */
  async function save(): Promise<'saved' | 'refused' | false> {
    const next = contentWith(content, texts);
    const result = await callApi<DraftSaved>(
      'PUT',
      `${base}/draft`,
      { content: next, variantIds },
      csrfToken,
    );
    if (!result.ok) {
      fail(result.failure);
      return false;
    }
    setContent(next);
    setRefused(result.body.refusedFields);
    setDirty(result.body.refusedFields.length > 0);
    return result.body.refusedFields.length === 0 ? 'saved' : 'refused';
  }

  async function run(action: 'save' | 'submit') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setNotice(null);
    if (dirty || action === 'save' || content === undefined) {
      const saved = await save();
      if (saved !== 'saved' || action === 'save') {
        busy.current = false;
        setPending(false);
        if (saved === 'saved') setNotice('saved');
        return;
      }
    }
    const result = await callApi<Submitted>(
      'POST',
      `${base}/submit`,
      { replacePending },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (!result.ok) {
      fail(result.failure);
      return;
    }
    setNotice(result.body.published ? 'published' : 'submitted');
    router.refresh();
  }

  function change(locale: string, key: TextKey, value: string) {
    setTexts({
      ...texts,
      [locale]: { ...(texts[locale] as Record<TextKey, string>), [key]: value },
    });
    setDirty(true);
    setNotice(null);
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run('save');
  }

  const refusedAt = (locale: string, key: TextKey): boolean =>
    refused.some(
      (item) =>
        item.locale === locale &&
        item.ref === null &&
        item.field.endsWith(
          key === 'name'
            ? 'name'
            : key === 'shortDescription'
              ? 'short-description'
              : 'description',
        ),
    );

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {notice === null ? null : (
        <Banner tone="success">{t(`catalog.edit.notice.${notice}`)}</Banner>
      )}
      {refused.length > 0 ? <Banner tone="attention">{t('catalog.edit.refused')}</Banner> : null}
      {problem === null ? null : (
        <Banner tone="critical">
          <p>{t(problem.key, problem.values)}</p>
          {problem.details.length > 0 ? (
            <ul className="mt-1 list-disc ps-5 text-sm">
              {problem.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {problem.reload ? (
            <Button variant="link" onClick={() => router.refresh()}>
              {t('catalog.edit.reload')}
            </Button>
          ) : null}
        </Banner>
      )}
      {locales.map((locale) => (
        <Card key={locale} title={t('catalog.edit.locale', { locale })}>
          {KEYS.map((key) => (
            <TextField
              key={key}
              name={`${locale}.${key}`}
              label={t(`catalog.edit.field.${key}`)}
              optionalLabel={key === 'name' ? undefined : t('catalog.create.optional')}
              value={texts[locale]?.[key] ?? ''}
              error={refusedAt(locale, key) ? t('catalog.edit.refused-field') : undefined}
              onChange={(event) => change(locale, key, event.target.value)}
            />
          ))}
        </Card>
      ))}
      {product.pending !== null ? (
        <CheckboxRow
          name="replacePending"
          label={t('catalog.edit.replace-pending')}
          checked={replacePending}
          onChange={(event) => setReplacePending(event.target.checked)}
        />
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" variant="secondary" loading={pending} disabled={pending}>
          {t('catalog.edit.save')}
        </Button>
        <Button disabled={pending} onClick={() => void run('submit')}>
          {t('catalog.edit.submit')}
        </Button>
        <a className="font-medium text-link underline" href={`/products/${product.productId}`}>
          {t('catalog.edit.back')}
        </a>
      </div>
    </form>
  );
}
