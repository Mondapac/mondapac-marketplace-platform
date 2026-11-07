'use client';

import {
  BackLink,
  Banner,
  Button,
  Card,
  Dialog,
  LoadError,
  SearchSelect,
  Select,
  SkeletonRows,
  TextAreaField,
  TextField,
  UnsavedBar,
  toast,
  useUnsavedChangesGuard,
  type SearchSelectLabels,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
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
  topicIdsOf,
  variantRowsOf,
  variantsWith,
  withMintedIds,
  type AttributeInput,
  type AttributeInputs,
  type VariantRow,
} from './draft-content.ts';
import { problemOf, type FormProblem } from './errors.ts';
import { TagField, topicSentences, useKnownTags } from './tag-field.tsx';
import { blockersOf, listOf } from './publish-state.ts';
import {
  ActiveRow,
  OrganisationCard,
  SellersCard,
  StatusBadge,
  StatusCard,
} from './side-cards.tsx';
import { VariantsSection } from './variants-section.tsx';
import {
  BASE,
  BULK,
  MAX_TAGS,
  readable,
  type BulkAnswer,
  type DraftSaved,
  type ProductView,
  type Submitted,
} from './types.ts';

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
  marketName,
  timeZone,
  canPause,
  canReadTags,
}: {
  readonly productId: string;
  readonly csrfToken: string;
  readonly marketName: string;
  /** The admin's own zone, for the date a product was paused. */
  readonly timeZone: string;
  /** The admin holds `catalog.product.pause`: the Active switch is shown. */
  readonly canPause: boolean;
  /** The admin holds `catalog.topic.read`: the Tags field can search; otherwise it only lists. */
  readonly canReadTags: boolean;
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
      marketName={marketName}
      timeZone={timeZone}
      canPause={canPause}
      canReadTags={canReadTags}
      onReload={() => void load()}
    />
  );
}

/** The language of a locale code in English ("en" is "English"); the code itself if unknown. */
function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** True when the draft was saved after the published revision: the revision badge shows. */
function hasSavedRevision(product: ProductView): boolean {
  const { published, workingCopy } = product;
  if (published === null || workingCopy === null) return false;
  return Date.parse(workingCopy.lastSavedAt) > Date.parse(published.submittedAt);
}

function EditForm({
  product,
  csrfToken,
  marketName,
  timeZone,
  canPause,
  canReadTags,
  onReload,
}: {
  readonly product: ProductView;
  readonly csrfToken: string;
  readonly marketName: string;
  readonly timeZone: string;
  readonly canPause: boolean;
  readonly canReadTags: boolean;
  readonly onReload: () => void;
}) {
  const t = useTranslations('catalog.productForm');
  const locale = useLocale();
  const defaultLocale = product.locales.default;
  const { form } = product;
  const configurable = product.variantModel === 'configurable';
  const attributeFields = form.fields.filter((field) => !field.isVariantOption);
  const [content, setContent] = useState(product.workingCopy?.content);
  const [texts, setTexts] = useState(() => textsOf(content, defaultLocale));
  const [categoryIds, setCategoryIds] = useState<string[]>(() => categoryIdsOf(content));
  const [taxCategoryCode, setTaxCategoryCode] = useState(() => taxCategoryOf(content));
  const [topicIds, setTopicIds] = useState<string[]>(() => topicIdsOf(content));
  const knownTags = useKnownTags(product.topicRefs ?? [], defaultLocale);
  const [inputs, setInputs] = useState<AttributeInputs>(() =>
    attributeInputsOf(content, attributeFields),
  );
  const [rows, setRows] = useState<VariantRow[]>(() => variantRowsOf(content, product.variants));
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<FormProblem | null>(null);
  const [refused, setRefused] = useState<DraftSaved['refusedFields']>([]);
  const [status, setStatus] = useState(product.status);
  const [publishedNo, setPublishedNo] = useState(product.published?.revisionNo ?? null);
  const [hasRevision, setHasRevision] = useState(() => hasSavedRevision(product));
  const [pausedAt, setPausedAt] = useState(product.pausedAt);
  const [justPublished, setJustPublished] = useState(false);
  const busy = useRef(false);
  const [confirm, setConfirm] = useState<'discard' | 'publish' | 'off' | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const savedName = textsOf(content, defaultLocale).name;
  const shownTitle = savedName === '' ? t('page.untitled') : savedName;
  // The dialog names what is about to go out: the title as it stands in the field.
  const typedTitle = texts.name.trim() === '' ? t('page.untitled') : texts.name.trim();
  // Leaving with edits that are not saved asks first (the same dialog the settings pages use).
  const guard = useUnsavedChangesGuard(dirty, {
    title: t('leave.title'),
    message:
      savedName === '' ? t('leave.message-untitled') : t('leave.message', { title: savedName }),
    stay: t('leave.stay'),
    leave: t('leave.leave'),
    destructive: true,
  });

  const fixedVariantIds = product.variants
    .filter((variant) => variant.state !== 'retired')
    .map((variant) => variant.variantId);
  const base = `${BASE}/${product.productId}`;
  const published = publishedNo !== null || status === 'published';
  // A product that was never published and has no title yet is still being added.
  const adding = !published && savedName === '';
  const nextNo = (publishedNo ?? 0) + 1;
  const inactive = status === 'published' && pausedAt !== null;

  const labels: Partial<SearchSelectLabels> = {
    search: t('select.search'),
    noResults: t('select.no-results'),
    loading: t('select.loading'),
    retry: t('select.retry'),
    remove: (name) => t('select.remove', { name }),
    limitReached: (max) => t('select.limit', { max }),
  };
  const categories = categoryOptions(form.categories, defaultLocale);

  // What the freeze refused about the tags, in words, until the admin changes the tags.
  const tagIssues = problem?.topicIssues ?? [];
  const tagSentences = topicSentences(t, tagIssues, topicIds, knownTags, MAX_TAGS);

  const missing = blockersOf({
    name: texts.name,
    categoryIds,
    taxCategoryCode,
    fields: attributeFields,
    inputs,
  });
  const blockers =
    missing.length === 0
      ? null
      : t('blockers.lead', {
          items: listOf(
            missing.map((item) => t(`blockers.${item}`)),
            locale,
          ),
        });
  const canPublish = missing.length === 0 && (!published || dirty || hasRevision);

  function fail(failure: Parameters<typeof problemOf>[0]) {
    if (failure.status === 401) window.location.assign('/session-ended');
    else setProblem(problemOf(failure));
  }

  function contentOf(list: readonly VariantRow[]): Record<string, unknown> {
    return contentFrom(contentWithTexts(content, defaultLocale, texts), {
      categoryIds,
      topicIds,
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
    if (published) setHasRevision(true);
    return result.body.refusedFields.length === 0 ? 'saved' : 'refused';
  }

  async function run(action: 'save' | 'publish') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setJustPublished(false);
    if (dirty || action === 'save' || content === undefined) {
      const saved = await save();
      if (saved !== 'saved' || action === 'save') {
        busy.current = false;
        setPending(false);
        if (saved === 'saved')
          toast.success(t(published ? 'notice.revision-saved' : 'notice.saved'));
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
    if (result.body.published) {
      setStatus('published');
      setPublishedNo(result.body.revisionNo);
      setHasRevision(false);
      setJustPublished(true);
    } else setSubmitted(true);
    toast.success(t(result.body.published ? 'notice.published' : 'notice.submitted'));
  }

  /** Turns a published product off (pause) or on (resume) through the bulk route, one id. */
  async function setActive(on: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<BulkAnswer>(
      'POST',
      BULK,
      { action: on ? 'resume' : 'pause', productIds: [product.productId] },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    setConfirm(null);
    if (!result.ok) {
      fail(result.failure);
      return;
    }
    if (result.body.counts.done !== 1) {
      setProblem({ key: 'pause-failed', details: [], reload: true });
      return;
    }
    setPausedAt(on ? null : new Date().toISOString());
    toast.success(t(on ? 'notice.turned-on' : 'notice.turned-off'));
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
    setConfirm(null);
    if (!result.ok) {
      fail(result.failure);
      return;
    }
    flushSync(() => setDirty(false));
    window.location.assign('/catalog/products');
  }

  /** Throws the edits away: the product is read again and the form starts over. */
  function discardChanges() {
    flushSync(() => setDirty(false));
    onReload();
  }

  const edited = () => {
    setDirty(true);
    setJustPublished(false);
  };
  const clearRefused = (match: (item: DraftSaved['refusedFields'][number]) => boolean) =>
    setRefused((list) => list.filter((item) => !match(item)));
  const refusedAt = (key: 'name' | 'description') =>
    refused.find(
      (item) => item.locale === defaultLocale && item.ref === null && item.field.endsWith(key),
    );
  const refusedMessage = (item: DraftSaved['refusedFields'][number] | undefined) =>
    item === undefined
      ? undefined
      : item.code.startsWith('claim-text')
        ? t('field.name-claim')
        : t('refused-field');

  function submit(event: FormEvent) {
    event.preventDefault();
    void run('save');
  }

  const stale = problem?.key === 'stale';
  const publishing = confirm === 'publish';
  const variantCount = configurable ? rows.length : fixedVariantIds.length;

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {guard.dialog}
      <Dialog
        open={confirm === 'discard'}
        title={t('discard.title')}
        onClose={() => setConfirm(null)}
        initialFocus={keepRef}
        actions={
          <>
            <Button ref={keepRef} variant="secondary" onClick={() => setConfirm(null)}>
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
      <Dialog
        open={publishing}
        title={
          published
            ? t('publish-dialog.revision-title', { n: nextNo, title: typedTitle })
            : t('publish-dialog.title', { title: typedTitle })
        }
        onClose={() => setConfirm(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setConfirm(null)}>
              {t('publish-dialog.cancel')}
            </Button>
            <Button
              loading={pending}
              onClick={() => {
                setConfirm(null);
                void run('publish');
              }}
            >
              {t('publish-dialog.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('publish-dialog.body', { market: marketName })}</p>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-fg-muted">{t('publish-dialog.variants')}</dt>
          <dd>{variantCount}</dd>
          <dt className="text-fg-muted">{t('publish-dialog.texts')}</dt>
          <dd>{t('publish-dialog.texts-value', { language: languageName(defaultLocale) })}</dd>
        </dl>
      </Dialog>
      <Dialog
        open={confirm === 'off'}
        title={t('active.off.title', { title: shownTitle })}
        onClose={() => setConfirm(null)}
        initialFocus={keepRef}
        actions={
          <>
            <Button ref={keepRef} variant="secondary" onClick={() => setConfirm(null)}>
              {t('active.off.cancel')}
            </Button>
            <Button
              variant="destructive-solid"
              loading={pending}
              onClick={() => void setActive(false)}
            >
              {t('active.off.confirm')}
            </Button>
          </>
        }
      >
        <p>{t('active.off.body')}</p>
        <dl className="mt-3 flex items-center justify-between gap-4 rounded-md bg-subtle p-3 text-sm">
          <dt>{t('active.off.impact')}</dt>
          <dd className="font-semibold">{product.offers.offerCount}</dd>
        </dl>
      </Dialog>
      {dirty ? (
        <UnsavedBar
          region={t('bar.region')}
          label={
            refused.length > 0
              ? t('bar.errors', { count: refused.length })
              : t(published ? 'bar.unsaved-changes' : 'bar.unsaved-product')
          }
          error={refused.length > 0}
          discardLabel={t('bar.discard')}
          saveLabel={t(published ? 'bar.save-revision' : 'bar.save-draft')}
          saving={pending}
          onDiscard={discardChanges}
        />
      ) : null}
      <BackLink href="/catalog/products" label={t('back')} />
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold">
            {adding ? t('create.title') : shownTitle}
          </h1>
          {adding ? null : <StatusBadge status={status} />}
        </div>
        <p className="text-sm text-fg-muted">
          {adding
            ? t('page.subtitle-add', { market: marketName })
            : t('page.subtitle-edit', { market: marketName, code: product.productCode })}
        </p>
      </div>
      {justPublished ? (
        <Banner tone="success" title={t('banner.published-title', { title: shownTitle })}>
          {t('banner.published-body')}
        </Banner>
      ) : null}
      {problem === null ? null : (
        <Banner
          tone={stale ? 'attention' : 'critical'}
          {...(stale ? { title: t('banner.stale-title') } : {})}
        >
          <p>{stale ? t('banner.stale-body') : t(`error.${problem.key}`, problem.values)}</p>
          {problem.details.length + tagSentences.length > 0 ? (
            <ul className="mt-1 list-disc ps-5 text-sm">
              {tagSentences.map((line) => (
                <li key={line}>{line}</li>
              ))}
              {problem.details.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : null}
          {problem.reload ? (
            <Button variant="link" onClick={onReload}>
              {stale ? t('banner.reload') : t('reload')}
            </Button>
          ) : null}
        </Banner>
      )}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21.25rem] lg:grid-rows-[auto_1fr] lg:items-start">
        <div className="lg:col-start-2 lg:row-start-1">
          <StatusCard
            status={status}
            publishedNo={publishedNo}
            nextNo={nextNo}
            hasRevision={hasRevision}
            blockers={blockers}
            canPublish={canPublish}
            pending={pending}
            onPublish={() => setConfirm('publish')}
            onDiscard={
              published || submitted || status !== 'draft' ? null : () => setConfirm('discard')
            }
            active={
              canPause && status === 'published' ? (
                <ActiveRow
                  inactive={inactive}
                  pausedAt={pausedAt}
                  offerCount={product.offers.offerCount}
                  timeZone={timeZone}
                  pending={pending}
                  onChange={(on) => (on ? void setActive(true) : setConfirm('off'))}
                />
              ) : null
            }
          />
        </div>
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1">
          {inactive ? (
            <Banner tone="attention" title={t('active.banner-title')}>
              <p>{t('active.banner-body', { count: product.offers.offerCount })}</p>
              {canPause ? (
                <Button variant="link" disabled={pending} onClick={() => void setActive(true)}>
                  {t('active.turn-on')}
                </Button>
              ) : null}
            </Banner>
          ) : null}
          <Card title={t('title-card')}>
            <TextField
              name="name"
              label={t('field.name')}
              help={t('field.name-help')}
              value={texts.name}
              error={refusedMessage(refusedAt('name'))}
              onChange={(event) => {
                setTexts({ ...texts, name: event.target.value });
                clearRefused((item) => item.ref === null && item.field.endsWith('name'));
                edited();
              }}
            />
            <TextAreaField
              name="description"
              label={t('field.description')}
              optionalLabel={t('optional')}
              value={texts.description}
              error={refusedMessage(refusedAt('description'))}
              onChange={(event) => {
                setTexts({ ...texts, description: event.target.value });
                clearRefused((item) => item.ref === null && item.field.endsWith('description'));
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
              help={t(
                categoryIds.length === 0 ? 'field.categories-help-empty' : 'field.categories-help',
              )}
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
              placeholder={t('field.tax-placeholder')}
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
            <TagField
              ids={topicIds}
              known={knownTags}
              defaultLocale={defaultLocale}
              issues={tagIssues}
              max={MAX_TAGS}
              canRead={canReadTags}
              onChange={(ids) => {
                setTopicIds(ids);
                // The refusals named the old list; they say nothing about this one.
                setProblem((current) =>
                  current?.topicIssues === undefined ? current : { ...current, topicIssues: [] },
                );
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
            categoryChosen={categoryIds.length > 0}
            onChange={(code: string, value: AttributeInput | undefined) => {
              setInputs({ ...inputs, [code]: value });
              clearRefused((item) => item.ref === code);
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
              clearRefused((item) => rows.some((row) => row.variantId === item.ref));
              edited();
            }}
          />
        </div>
        <div className="flex flex-col gap-4 lg:col-start-2 lg:row-start-2">
          <OrganisationCard marketName={marketName} typeCode={product.typeCode} />
          {status === 'published' ? (
            <SellersCard
              sellerCount={product.offers.sellerCount}
              offerCount={product.offers.offerCount}
            />
          ) : null}
        </div>
      </div>
    </form>
  );
}
