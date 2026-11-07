'use client';

import {
  BackLink,
  Badge,
  Banner,
  Button,
  Card,
  LoadError,
  SearchSelect,
  Select,
  SkeletonRows,
  TextAreaField,
  TextField,
  Dialog,
  toast,
  useUnsavedChangesGuard,
  type SearchSelectLabels,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../../api/client.ts';
import { AttributesSection } from './attributes-section.tsx';
import { categoryOptions } from './category-options.ts';
import {
  attributeInputsOf,
  attributeValuesWith,
  categoryIdsOf,
  contentFrom,
  taxCategoryOf,
  variantRowsOf,
  variantsWith,
  withMintedIds,
  type AttributeInput,
  type AttributeInputs,
  type VariantRow,
} from './draft-content.ts';
import { problemOf, type FormProblem } from './errors.ts';
import { VariantsSection } from './variants-section.tsx';
import { BASE, readable, type DraftSaved, type ProductView, type Submitted } from './types.ts';

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The default-language title and description a saved draft holds. */
export function textsOf(
  content: Readonly<Record<string, unknown>> | undefined,
  locale: string,
): { name: string; description: string } {
  const texts = content?.['texts'];
  const entry = isObject(texts) ? texts[locale] : undefined;
  const read = (key: string) =>
    isObject(entry) && typeof entry[key] === 'string' ? entry[key] : '';
  return { name: read('name'), description: read('description') };
}

/**
 * The saved content with the default language's title and description replaced. Every other key of
 * the draft is sent back as it was, the other languages and the short description included.
 */
export function contentWithTexts(
  content: Readonly<Record<string, unknown>> | undefined,
  locale: string,
  next: { readonly name: string; readonly description: string },
): Record<string, unknown> {
  const stored = content?.['texts'];
  const texts: Record<string, unknown> = isObject(stored) ? { ...stored } : {};
  const saved = texts[locale];
  const entry: Record<string, unknown> = isObject(saved) ? { ...saved } : {};
  for (const [key, value] of Object.entries(next)) {
    const text = value.trim();
    if (text === '') delete entry[key];
    else entry[key] = text;
  }
  if (Object.keys(entry).length === 0) delete texts[locale];
  else texts[locale] = entry;
  return { ...(content ?? {}), texts };
}

type Phase =
  | { readonly kind: 'loading' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'ready'; readonly product: ProductView };

/** The admin's "Edit product" page: loads one platform product and shows its form. */
export function ProductEdit({
  productId,
  csrfToken,
}: {
  readonly productId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.productForm');
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  // Bumped to remount the form on freshly read data.
  const [generation, setGeneration] = useState(0);

  const load = useCallback(async () => {
    setPhase({ kind: 'loading' });
    const result = await callApi<ProductView>('GET', `${BASE}/${productId}`);
    if (result.ok) {
      setPhase({ kind: 'ready', product: result.body });
      setGeneration((value) => value + 1);
    } else if (result.failure.status === 401) window.location.assign('/session-ended');
    else if (result.failure.status === 404) setPhase({ kind: 'not-found' });
    else setPhase({ kind: 'failed' });
  }, [productId]);
  useEffect(() => {
    void load();
  }, [load]);

  if (phase.kind === 'loading') return <SkeletonRows label={t('loading')} rows={6} />;
  if (phase.kind === 'failed') {
    return (
      <LoadError message={t('load-failed')} retryLabel={t('retry')} onRetry={() => void load()} />
    );
  }
  if (phase.kind === 'not-found') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-fg-muted">{t('not-found')}</p>
        <BackLink href="/catalog/products" label={t('back')} />
      </div>
    );
  }
  return (
    <EditForm
      key={generation}
      product={phase.product}
      csrfToken={csrfToken}
      onReload={() => void load()}
    />
  );
}

const STATUS_TONE: Readonly<Record<string, 'neutral' | 'success' | 'attention'>> = {
  draft: 'neutral',
  published: 'success',
  paused: 'attention',
};

function EditForm({
  product,
  csrfToken,
  onReload,
}: {
  readonly product: ProductView;
  readonly csrfToken: string;
  readonly onReload: () => void;
}) {
  const t = useTranslations('catalog.productForm');
  const defaultLocale = product.locales.default;
  const { form } = product;
  const configurable = product.variantModel === 'configurable';
  const attributeFields = form.fields.filter((field) => !field.isVariantOption);
  const [content, setContent] = useState(product.workingCopy?.content);
  const [texts, setTexts] = useState(() => textsOf(content, defaultLocale));
  const [categoryIds, setCategoryIds] = useState<string[]>(() => categoryIdsOf(content));
  const [taxCategoryCode, setTaxCategoryCode] = useState(() => taxCategoryOf(content));
  const [inputs, setInputs] = useState<AttributeInputs>(() =>
    attributeInputsOf(content, attributeFields),
  );
  const [rows, setRows] = useState<VariantRow[]>(() => variantRowsOf(content, product.variants));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [refused, setRefused] = useState<DraftSaved['refusedFields']>([]);
  const [status, setStatus] = useState(product.status);
  const busy = useRef(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  // Leaving with edits that are not saved asks first (the same dialog the settings pages use).
  const guard = useUnsavedChangesGuard(dirty, {
    title: t('leave.title'),
    message: t('leave.message'),
    stay: t('leave.stay'),
    leave: t('leave.leave'),
  });

  const fixedVariantIds = product.variants
    .filter((variant) => variant.state !== 'retired')
    .map((variant) => variant.variantId);
  const base = `${BASE}/${product.productId}`;
  const published = product.published !== null || status === 'published';

  const labels: Partial<SearchSelectLabels> = {
    search: t('select.search'),
    noResults: t('select.no-results'),
    loading: t('select.loading'),
    retry: t('select.retry'),
    remove: (name) => t('select.remove', { name }),
    limitReached: (max) => t('select.limit', { max }),
  };
  const categories = categoryOptions(form.categories, defaultLocale);

  function fail(failure: Parameters<typeof problemOf>[0]) {
    if (failure.status === 401) window.location.assign('/session-ended');
    else setProblem(problemOf(failure));
  }

  function contentOf(list: readonly VariantRow[]): Record<string, unknown> {
    return contentFrom(contentWithTexts(content, defaultLocale, texts), {
      categoryIds,
      taxCategoryCode,
      attributeValues: attributeValuesWith(content, attributeFields, inputs, defaultLocale),
      variants: configurable ? variantsWith(list) : null,
    });
  }

  /** Saves the draft; 'saved' when the API took it whole, 'refused' when it dropped some texts. */
  async function save(): Promise<'saved' | 'refused' | false> {
    let list = rows;
    let idsMinted = false;
    let next = contentOf(list);
    const ids = (): (string | null)[] =>
      configurable ? list.map((row) => row.variantId) : fixedVariantIds;
    let result = await callApi<DraftSaved>(
      'PUT',
      `${base}/draft`,
      { content: next, variantIds: ids() },
      csrfToken,
    );
    // A variant added here has no id until the server mints one: write the draft again with it.
    if (result.ok && list.some((row) => row.variantId === null)) {
      list = withMintedIds(list, result.body.variantIds);
      idsMinted = true;
      setRows(list);
      next = contentOf(list);
      result = await callApi<DraftSaved>(
        'PUT',
        `${base}/draft`,
        { content: next, variantIds: ids() },
        csrfToken,
      );
    }
    if (!result.ok) {
      if (idsMinted && result.failure.status !== 401) {
        // The server holds the new variants but the draft still names them by their local keys.
        setProblem({ key: 'partial', details: [], reload: false });
      } else fail(result.failure);
      return false;
    }
    setContent(next);
    setRefused(result.body.refusedFields);
    setDirty(result.body.refusedFields.length > 0);
    return result.body.refusedFields.length === 0 ? 'saved' : 'refused';
  }

  async function run(action: 'save' | 'publish') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    if (dirty || action === 'save' || content === undefined) {
      const saved = await save();
      if (saved !== 'saved' || action === 'save') {
        busy.current = false;
        setPending(false);
        if (saved === 'saved') toast.success(t('notice.saved'));
        return;
      }
    }
    const result = await callApi<Submitted>(
      'POST',
      `${base}/submit`,
      { replacePending: false },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (!result.ok) {
      fail(result.failure);
      return;
    }
    if (result.body.published) setStatus('published');
    else setSubmitted(true);
    toast.success(t(result.body.published ? 'notice.published' : 'notice.submitted'));
  }

  /** Drops a product that was never published; the form is left without the leave prompt. */
  async function discard() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<{ productId: string }>('POST', `${base}/discard`, {}, csrfToken);
    busy.current = false;
    setPending(false);
    setConfirmDiscard(false);
    if (!result.ok) {
      fail(result.failure);
      return;
    }
    flushSync(() => setDirty(false));
    window.location.assign('/catalog/products');
  }

  const edited = () => setDirty(true);
  const refusedAt = (key: 'name' | 'description'): boolean =>
    refused.some(
      (item) => item.locale === defaultLocale && item.ref === null && item.field.endsWith(key),
    );

  function submit(event: FormEvent) {
    event.preventDefault();
    void run('save');
  }

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {guard.dialog}
      <Dialog
        open={confirmDiscard}
        title={t('discard.title')}
        onClose={() => setConfirmDiscard(false)}
        initialFocus={keepRef}
        actions={
          <>
            <Button ref={keepRef} variant="secondary" onClick={() => setConfirmDiscard(false)}>
              {t('discard.keep')}
            </Button>
            <Button variant="destructive-solid" loading={pending} onClick={() => void discard()}>
              {t('discard.confirm')}
            </Button>
          </>
        }
      >
        {t('discard.message')}
      </Dialog>
      <BackLink href="/catalog/products" label={t('back')} />
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{t('edit.title')}</h1>
          <p className="text-sm text-fg-muted">
            {t('edit.subtitle', { code: product.productCode, type: readable(product.typeCode) })}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant="secondary"
            loading={pending}
            disabled={pending || (!dirty && content !== undefined)}
          >
            {t('save-draft')}
          </Button>
          {published || submitted || status !== 'draft' ? null : (
            <Button
              variant="destructive"
              disabled={pending}
              onClick={() => setConfirmDiscard(true)}
            >
              {t('discard.button')}
            </Button>
          )}
          <Button disabled={pending} onClick={() => void run('publish')}>
            {t(published ? 'publish-changes' : 'publish')}
          </Button>
        </div>
      </div>
      {refused.length > 0 ? <Banner tone="attention">{t('refused')}</Banner> : null}
      {problem === null ? null : (
        <Banner tone="critical">
          <p>{t(`error.${problem.key}`, problem.values)}</p>
          {problem.details.length > 0 ? (
            <ul className="mt-1 list-disc ps-5 text-sm">
              {problem.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {problem.reload ? (
            <Button variant="link" onClick={onReload}>
              {t('reload')}
            </Button>
          ) : null}
        </Banner>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="flex min-w-0 flex-col gap-4">
          <Card title={t('title-card')}>
            <TextField
              name="name"
              label={t('field.name')}
              help={t('field.name-help')}
              value={texts.name}
              error={refusedAt('name') ? t('refused-field') : undefined}
              onChange={(event) => {
                setTexts({ ...texts, name: event.target.value });
                edited();
              }}
            />
            <TextAreaField
              name="description"
              label={t('field.description')}
              optionalLabel={t('optional')}
              value={texts.description}
              error={refusedAt('description') ? t('refused-field') : undefined}
              onChange={(event) => {
                setTexts({ ...texts, description: event.target.value });
                edited();
              }}
            />
          </Card>
          <Card title={t('category')}>
            <SearchSelect
              multiple
              alwaysSearch
              name="categoryIds"
              label={t('field.categories')}
              help={t('field.categories-help')}
              placeholder={t('field.categories-placeholder')}
              options={categories}
              value={categories.filter((option) => categoryIds.includes(option.value))}
              labels={labels}
              onChange={(picked) => {
                setCategoryIds(picked.map((option) => option.value));
                edited();
              }}
            />
            <Select
              name="taxCategoryCode"
              label={t('field.tax')}
              help={t('field.tax-help')}
              placeholder={t('attribute.unset')}
              options={form.taxCategoryCodes.map((code) => ({
                value: code,
                label: readable(code),
              }))}
              value={taxCategoryCode}
              onChange={(event) => {
                setTaxCategoryCode(event.target.value);
                edited();
              }}
            />
          </Card>
          <AttributesSection
            fields={attributeFields}
            inputs={inputs}
            defaultLocale={defaultLocale}
            refused={refused}
            labels={labels}
            onChange={(code: string, value: AttributeInput | undefined) => {
              setInputs({ ...inputs, [code]: value });
              edited();
            }}
          />
          <VariantsSection
            configurable={configurable}
            rows={rows}
            fields={form.fields}
            defaultLocale={defaultLocale}
            max={product.maxVariants}
            published={published}
            refused={refused}
            onChange={(next) => {
              setRows(next);
              edited();
            }}
          />
        </div>
        <aside className="flex flex-col gap-4">
          <Card title={t('status.title')}>
            <div>
              <Badge tone={STATUS_TONE[status] ?? 'neutral'}>{t(`status.${status}`)}</Badge>
            </div>
            <p className="text-sm text-fg-muted">
              {t(published ? 'status.live-help' : 'status.draft-help')}
            </p>
          </Card>
          <Card title={t('organisation.title')}>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
              <dt className="text-fg-muted">{t('organisation.type')}</dt>
              <dd>{readable(product.typeCode)}</dd>
              <dt className="text-fg-muted">{t('organisation.scope')}</dt>
              <dd>{t('organisation.platform')}</dd>
            </dl>
            <p className="text-sm text-fg-muted">{t('organisation.help')}</p>
          </Card>
        </aside>
      </div>
    </form>
  );
}
