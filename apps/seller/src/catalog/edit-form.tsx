'use client';

import {
  BackLink,
  Banner,
  Button,
  Card,
  DescriptionWriter,
  TextAreaField,
  TextField,
  SaveBar,
  toast,
  useUnsavedChangesGuard,
} from '@mondapac/ui';
import { useLocale, useTimeZone, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../api/client.ts';
import { AddSizesDialog } from './add-sizes-dialog.tsx';
import { defaultCondition, LaterCard, YourOfferCard } from './add-offer.tsx';
import { canAddSizes, maxAxesOf, publishedAxesOf } from './add-sizes.ts';
import { AttributesSection } from './attributes-section.tsx';
import { ClassificationSection } from './classification-section.tsx';
import { PhotosSection } from './photos-section.tsx';
import {
  attributeInputsOf,
  attributeValuesWith,
  categoryIdsOf,
  contentFrom,
  isMeasureInput,
  taxCategoryOf,
  topicIdsOf,
  variantRowsOf,
  variantsWith,
  withMintedIds,
  type AttributeInput,
  type AttributeInputs,
  type VariantRow,
} from './draft-content.ts';
import { createProblemOf, type CreateProblem } from './create-errors.ts';
import { editProblemOf, type EditProblem } from './edit-errors.ts';
import { DEFAULT_MAX_TAGS, TagField, topicSentences, useKnownTags } from './tag-field.tsx';
import { formatInstant } from './format.ts';
import { SUGGESTING_STATUSES } from './suggestion-fields.ts';
import { OrganisationCard, StatusBadge, StatusCard, type Blocker } from './product-side.tsx';
import { writerCategory, writerDetails } from './writer-inputs.ts';
import { VariantsSection } from './variants-section.tsx';
import { hasProblems, problemsOfRows } from './variant-fields.ts';
import { axesOf } from './variant-grid.ts';
import type {
  DraftSaved,
  ProductCreated,
  ProductOptions,
  ProductPhoto,
  ProductView,
  Submitted,
} from './types.ts';

const KEYS = ['name', 'shortDescription', 'description'] as const;
type TextKey = (typeof KEYS)[number];
type Texts = Record<TextKey, string>;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The default-language title, short description and description a saved draft holds. */
export function textsOf(
  content: Readonly<Record<string, unknown>> | undefined,
  locale: string,
): Texts {
  const stored = content?.['texts'];
  const entry = isObject(stored) ? stored[locale] : undefined;
  const read = (key: TextKey) =>
    isObject(entry) && typeof entry[key] === 'string' ? entry[key] : '';
  return {
    name: read('name'),
    shortDescription: read('shortDescription'),
    description: read('description'),
  };
}

/**
 * The saved content with the default language's texts replaced (ADR-0046: entered once). Every
 * other key of the draft is sent back as it was, the other languages included.
 */
export function contentWith(
  content: Readonly<Record<string, unknown>> | undefined,
  locale: string,
  next: Texts,
): Record<string, unknown> {
  const stored = content?.['texts'];
  const texts: Record<string, unknown> = isObject(stored) ? { ...stored } : {};
  const saved = texts[locale];
  const entry: Record<string, unknown> = isObject(saved) ? { ...saved } : {};
  for (const key of KEYS) {
    const text = next[key].trim();
    if (text === '') delete entry[key];
    else entry[key] = text;
  }
  if (Object.keys(entry).length === 0) delete texts[locale];
  else texts[locale] = entry;
  return { ...(content ?? {}), texts };
}

/** "a, b and c" for the "To submit:" line. */
function listOf(items: readonly string[], locale: string): string {
  try {
    return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
}

function filled(value: AttributeInput | undefined): boolean {
  if (value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'boolean') return true;
  if (Array.isArray(value)) return value.length > 0;
  if (isMeasureInput(value)) return value.amount.trim() !== '';
  if (typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((item) =>
      typeof item === 'string' ? item.trim() !== '' : item !== undefined && item !== null,
    );
  }
  return true;
}

/** The photo ids a saved draft lists, in order. */
function imageIdsOf(content: Readonly<Record<string, unknown>> | undefined): string[] {
  const stored = content?.['imageIds'];
  return Array.isArray(stored)
    ? stored.filter((item): item is string => typeof item === 'string')
    : [];
}

export function EditForm({
  product,
  photos,
  locales,
  defaultLocale,
  marketName,
  csrfToken,
  add,
}: {
  readonly product: ProductView;
  /** The product's photo library, or `null` when it could not be read. */
  readonly photos: readonly ProductPhoto[] | null;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly marketName: string;
  readonly csrfToken: string;
  /**
   * Set on the Add page: the form of a product that does not exist yet. Nothing is created until
   * the first Save draft, which creates the product with these options and then saves the page.
   */
  readonly add?: { readonly options: ProductOptions };
}) {
  const t = useTranslations();
  const locale = useLocale();
  const zone = useTimeZone();
  const router = useRouter();
  const [content, setContent] = useState(product.workingCopy?.content);
  // Title and description are entered once, in the default language (ADR-0046); the other
  // languages of the draft are sent back as they were.
  const [texts, setTexts] = useState<Texts>(() => textsOf(content, defaultLocale));
  const { form } = product;
  const configurable = product.variantModel === 'configurable';
  const attributeFields = form.fields.filter((field) => !field.isVariantOption);
  const [categoryIds, setCategoryIds] = useState<string[]>(() => categoryIdsOf(content));
  const [taxCategoryCode, setTaxCategoryCode] = useState(() => taxCategoryOf(content));
  const [topicIds, setTopicIds] = useState<string[]>(() => topicIdsOf(content));
  const [maxTags, setMaxTags] = useState(DEFAULT_MAX_TAGS);
  const knownTags = useKnownTags(product.topicRefs ?? [], defaultLocale);
  const [inputs, setInputs] = useState<AttributeInputs>(() =>
    attributeInputsOf(content, attributeFields),
  );
  const [rows, setRows] = useState<VariantRow[]>(() => variantRowsOf(content, product.variants));
  const [axes, setAxes] = useState<string[]>(() => axesOf(content, rows, form.fields));
  const [imageIds, setImageIds] = useState<string[]>(() => imageIdsOf(content));
  const adding = add !== undefined;
  // The offer fields of the Add page (the product's type, condition and the seller's own SKU).
  const [typeCode, setTypeCode] = useState('');
  const [conditionCode, setConditionCode] = useState(() =>
    add === undefined ? '' : defaultCondition(add.options),
  );
  const [sellerSku, setSellerSku] = useState('');
  const [offerProblem, setOfferProblem] = useState<CreateProblem | null>(null);
  const [dirty, setDirty] = useState(false);
  const [sizesOpen, setSizesOpen] = useState(false);
  // A new run of the dialog per opening: nothing of an earlier one (an error, a tick) survives.
  const [sizesRun, setSizesRun] = useState(0);
  const [replacePending, setReplacePending] = useState(false);
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<EditProblem | null>(null);
  const [refused, setRefused] = useState<DraftSaved['refusedFields']>([]);
  const [notices, setNotices] = useState<NonNullable<DraftSaved['variantNotices']>>([]);
  const busy = useRef(false);
  const savedName = textsOf(content, defaultLocale).name;
  const draftName = adding ? texts.name.trim() : savedName;
  const canSuggest = !adding && SUGGESTING_STATUSES.has(product.status);
  const shownTitle = savedName === '' ? t('catalog.edit.page.untitled') : savedName;
  const published = product.published !== null;
  // Leaving with edits that are not saved asks first (the same dialog the settings pages use).
  const guard = useUnsavedChangesGuard(dirty, {
    title: t('catalog.edit.leave.title'),
    message:
      draftName === ''
        ? t('catalog.edit.leave.message-untitled')
        : t('catalog.edit.leave.message', { title: draftName }),
    stay: t('catalog.edit.leave.stay'),
    leave: t('catalog.edit.leave.leave'),
    destructive: true,
  });

  const fixedVariantIds = product.variants
    .filter((variant) => variant.state !== 'retired')
    .map((variant) => variant.variantId);
  const publishedAxes = publishedAxesOf(product.published?.content, form.fields);
  const maxAxes = maxAxesOf(product.maxAxes);
  // The axes are locked once a Configurable revision is published; a Simple one has none yet.
  // A published revision whose content cannot be read keeps them locked, to be safe.
  const locked =
    publishedAxes !== null ||
    (product.published !== null && !Array.isArray(product.published.content?.['variants']));
  // A second type being added: every live variant must hold a value for it before submit.
  const secondMissing =
    configurable &&
    publishedAxes?.length === 1 &&
    axes.some((axis) => !publishedAxes.includes(axis)) &&
    rows.some((row) =>
      axes.some((axis) => !publishedAxes.includes(axis) && (row.options[axis] ?? '') === ''),
    );
  const base = `catalog/seller/products/${product.productId}`;

  // What the page can see is missing; the server stays the authority and its not-ready list is
  // shown when it refuses. A list the Market does not offer (no categories, no tax codes) cannot
  // be a gap.
  const missing: Blocker[] = [];
  if (texts.name.trim() === '') missing.push('title');
  if (adding && typeCode === '') missing.push('type');
  if (adding && sellerSku.trim() === '') missing.push('sku');
  if (form.categories.length > 0 && categoryIds.length === 0) missing.push('category');
  if (form.taxCategories.length > 0 && taxCategoryCode === '') missing.push('tax');
  if (attributeFields.some((field) => field.required && !filled(inputs[field.code]))) {
    missing.push('details');
  }
  // Category, tax and details come from the saved product: until it exists they are still open.
  if (adding) missing.push('save');
  const blockers =
    missing.length === 0
      ? null
      : t('catalog.edit.status.blockers', {
          items: listOf(
            missing.map((item) => t(`catalog.edit.status.${item}-item`)),
            locale,
          ),
        });

  function fail(failure: Parameters<typeof editProblemOf>[0]) {
    if (failure.status === 401) window.location.assign('/session-ended');
    else setProblem(editProblemOf(failure));
  }

  function contentOf(list: readonly VariantRow[]): Record<string, unknown> {
    const withTexts = contentWith(content, defaultLocale, texts);
    // `imageIds` stays out of a draft that never had photos, so it is sent back as it was.
    if (imageIds.length > 0 || 'imageIds' in withTexts) withTexts['imageIds'] = imageIds;
    return contentFrom(withTexts, {
      categoryIds,
      topicIds,
      taxCategoryCode,
      attributeValues: attributeValuesWith(content, attributeFields, inputs, defaultLocale),
      variants: configurable ? variantsWith(list) : null,
      variantAxes: configurable ? axes : null,
    });
  }

  /** Saves the draft; 'saved' when the API took it whole, 'refused' when it dropped some texts. */
  async function save(): Promise<'saved' | 'refused' | false> {
    // Barcode, shipping and photo picks that cannot be saved are fixed first, next to their fields.
    if (configurable && hasProblems(problemsOfRows(rows))) {
      setProblem({ key: 'catalog.edit.grid.problem.blocked', details: [], reload: false });
      return false;
    }
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
        setProblem({ key: 'catalog.edit.error.partial', details: [], reload: false });
      } else fail(result.failure);
      return false;
    }
    setContent(next);
    setRefused(result.body.refusedFields);
    setNotices(result.body.variantNotices ?? []);
    setDirty(result.body.refusedFields.length > 0);
    return result.body.refusedFields.length === 0 ? 'saved' : 'refused';
  }

  /**
   * The first Save draft of the Add page: creates the product with its draft offer, saves the
   * page's texts into its draft and opens the edit page of the new product. Once the product
   * exists it is never lost: a draft save that fails is told on the edit page.
   */
  async function createAndSave() {
    const fields: Record<string, string> = {};
    if (typeCode === '') fields['typeCode'] = 'catalog.create.validation.required';
    if (conditionCode === '') fields['conditionCode'] = 'catalog.create.validation.required';
    if (sellerSku.trim() === '') fields['sellerSku'] = 'catalog.create.validation.required';
    if (Object.keys(fields).length > 0) {
      setOfferProblem({ form: 'catalog.create.validation.summary', fields });
      busy.current = false;
      setPending(false);
      return;
    }
    const created = await callApi<ProductCreated>(
      'POST',
      'catalog/seller/products',
      // ADR-0046: the offer's own description is not asked here; the product text is the page's.
      { typeCode, sellerSku: sellerSku.trim(), conditionCode, description: {} },
      csrfToken,
    );
    if (!created.ok) {
      busy.current = false;
      setPending(false);
      if (created.failure.status === 401) window.location.assign('/session-ended');
      else setOfferProblem(createProblemOf(created.failure));
      return;
    }
    // From here the product exists: whatever happens next, the seller lands on its edit page.
    const { productId, variantIds } = created.body;
    const saved = await callApi<DraftSaved>(
      'PUT',
      `catalog/seller/products/${productId}/draft`,
      {
        content: contentFrom(contentWith(undefined, defaultLocale, texts), {
          categoryIds,
          taxCategoryCode,
          attributeValues: {},
          variants: null,
        }),
        variantIds,
      },
      csrfToken,
    );
    if (!saved.ok && saved.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (saved.ok && saved.body.refusedFields.length === 0) {
      toast.flash('success', t('catalog.edit.notice.saved'));
    } else if (saved.ok) {
      toast.flash('error', t('catalog.add.error.refused'));
    } else {
      const why = editProblemOf(saved.failure);
      toast.flash('error', t('catalog.add.error.not-saved', { reason: t(why.key, why.values) }));
    }
    // The page is left on purpose: the unsaved guard must not ask.
    flushSync(() => setDirty(false));
    try {
      router.replace(`/products/${productId}`);
    } catch {
      // The product exists, so the seller is not left locked in: the form unlocks and the back
      // link works. (A second Save draft would find the SKU taken by the product just created.)
      busy.current = false;
      setPending(false);
    }
  }

  async function run(action: 'save' | 'submit') {
    if (busy.current) return;
    if (adding && action === 'submit') return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    setOfferProblem(null);
    if (adding) {
      await createAndSave();
      return;
    }
    if (action === 'submit' && secondMissing) {
      setProblem({ key: 'catalog.edit.second.missing', details: [], reload: false });
      busy.current = false;
      setPending(false);
      return;
    }
    if (dirty || action === 'save' || content === undefined) {
      const saved = await save();
      if (saved !== 'saved' || action === 'save') {
        busy.current = false;
        setPending(false);
        if (saved === 'saved') toast.success(t('catalog.edit.notice.saved'));
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
    toast.success(t(`catalog.edit.notice.${result.body.published ? 'published' : 'submitted'}`));
    router.refresh();
  }

  function change(key: TextKey, value: string) {
    setTexts({ ...texts, [key]: value });
    const suffix =
      key === 'name' ? 'name' : key === 'shortDescription' ? 'short-description' : 'description';
    setRefused((list) =>
      list.filter((item) => !(item.ref === null && item.field.endsWith(suffix))),
    );
    setDirty(true);
  }

  function edited() {
    setDirty(true);
  }

  /** Throws the edits away: the product is read again and the form starts over. */
  function discardChanges() {
    flushSync(() => setDirty(false));
    window.location.reload();
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void run('save');
  }

  // What the freeze refused about the tags, in words, until the seller changes the tags.
  const tagIssues = problem?.topicIssues ?? [];
  const tagSentences = topicSentences(t, tagIssues, topicIds, knownTags, maxTags);

  const refusedAt = (key: TextKey) =>
    refused.find(
      (item) =>
        item.locale === defaultLocale &&
        item.ref === null &&
        item.field.endsWith(
          key === 'name'
            ? 'name'
            : key === 'shortDescription'
              ? 'short-description'
              : 'description',
        ),
    );
  const refusedMessage = (item: DraftSaved['refusedFields'][number] | undefined) =>
    item === undefined
      ? undefined
      : item.code.startsWith('claim-text')
        ? t('catalog.edit.field.name-claim')
        : t('catalog.edit.refused-field');

  return (
    <form
      // A focused field must not hide under the sticky save bar or the phone bottom bar (WCAG 2.4.11).
      className="flex flex-col gap-4 [&_:is(input,select,textarea,button,a)]:scroll-mb-[calc(var(--mp-size-bottom-bar)_+_8rem)] md:[&_:is(input,select,textarea,button,a)]:scroll-mb-32"
      onSubmit={submit}
      noValidate
    >
      {guard.dialog}
      <BackLink href="/products" label={t('catalog.create.back')} />
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold">
            {adding ? t('catalog.create.title') : shownTitle}
          </h1>
          {adding ? null : <StatusBadge status={product.status} />}
        </div>
        <p className="text-sm text-fg-muted">
          {adding
            ? t('catalog.add.subtitle', { market: marketName })
            : t('catalog.edit.page.subtitle', { market: marketName, code: product.productCode })}
        </p>
        {adding ? null : (
          <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-fg-muted">
            <span>
              {t('catalog.product.type')}: {product.typeCode}
            </span>
            <span>
              {t('catalog.col.changed')}: {formatInstant(product.lastChangedAt, locale, zone)}
            </span>
            <span>
              {t('catalog.product.created')}: {formatInstant(product.createdAt, locale, zone)}
            </span>
            {product.workingCopy === null ? null : (
              <span role="status">
                {t('catalog.product.saved-at', {
                  when: formatInstant(product.workingCopy.lastSavedAt, locale, zone),
                })}
              </span>
            )}
            {canSuggest ? (
              <a
                className="font-medium text-link underline"
                href={`/value-suggestions/new?product=${product.productId}`}
              >
                {t('catalog.suggestions.new.start')}
              </a>
            ) : null}
          </p>
        )}
      </div>
      {offerProblem === null ? null : <Banner tone="critical">{t(offerProblem.form)}</Banner>}
      {notices.length > 0 ? (
        <Banner tone="info">
          <p>{t('catalog.edit.grid.notice.duplicate', { count: notices.length })}</p>
          {[
            ...new Set(
              notices.flatMap((n) => (n.sellOnProductCode === null ? [] : [n.sellOnProductCode])),
            ),
          ].map((code) => (
            <p key={code}>{t('catalog.edit.grid.notice.sell-on', { code })}</p>
          ))}
        </Banner>
      ) : null}
      {problem === null ? null : (
        <Banner tone="critical">
          <p>{t(problem.key, problem.values)}</p>
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
            <Button variant="link" onClick={() => router.refresh()}>
              {t('catalog.edit.reload')}
            </Button>
          ) : null}
        </Banner>
      )}
      <fieldset disabled={adding && pending} className="min-w-0">
        {/* DOM order is the visual order (focus order, WCAG 2.4.3): Status, the product and its
            category, Your offer, the rest, Organisation. From lg the cards sit on an explicit
            grid: the main column on the left, the side cards on the right. */}
        <div
          className={`flex flex-col gap-4 lg:grid lg:grid-cols-[minmax(0,1fr)_21.25rem] lg:items-start ${
            adding ? 'lg:grid-rows-[auto_auto_1fr_auto]' : 'lg:grid-rows-[auto_1fr_auto]'
          }`}
        >
          <div className="lg:col-start-2 lg:row-start-1">
            <StatusCard
              status={product.status}
              waiting={product.pending !== null}
              published={published}
              blockers={blockers}
              canSubmit={missing.length === 0}
              pending={pending}
              onSubmit={() => void run('submit')}
              replacePending={
                product.pending === null
                  ? null
                  : { checked: replacePending, onChange: setReplacePending }
              }
            />
          </div>
          <div
            className={`flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-start-1 ${adding ? 'lg:row-span-3' : 'lg:row-span-2'}`}
          >
            {product.pausedAt === null ? null : (
              <Banner tone="attention" title={t('catalog.edit.paused.title')}>
                <p>{t('catalog.edit.paused.body')}</p>
              </Banner>
            )}
            {product.published !== null && product.sensitiveFields.length > 0 ? (
              <Banner tone="info">
                {t('catalog.edit.sensitive', {
                  fields: product.sensitiveFields
                    .map((field) => t(`catalog.edit.sensitive-field.${field}`))
                    .join(', '),
                })}
              </Banner>
            ) : null}
            <Card title={t('catalog.edit.product-card')}>
              {KEYS.map((key) =>
                key === 'description' ? (
                  <TextAreaField
                    key={key}
                    name={key}
                    label={t(`catalog.edit.field.${key}`)}
                    optionalLabel={t('catalog.create.optional')}
                    rows={5}
                    headAction={
                      <DescriptionWriter
                        call={callApi}
                        base="catalog/own/description-writer"
                        csrfToken={csrfToken}
                        title={texts.name}
                        category={writerCategory(form.categories, categoryIds, defaultLocale)}
                        details={writerDetails(attributeFields, inputs, defaultLocale)}
                        current={texts.description}
                        onText={(next) => change('description', next)}
                      />
                    }
                    value={texts[key]}
                    error={refusedMessage(refusedAt(key))}
                    onChange={(event) => change(key, event.target.value)}
                  />
                ) : (
                  <TextField
                    key={key}
                    name={key}
                    label={t(`catalog.edit.field.${key}`)}
                    {...(key === 'name' ? { help: t('catalog.edit.field.name-help') } : {})}
                    optionalLabel={key === 'name' ? undefined : t('catalog.create.optional')}
                    value={texts[key]}
                    error={refusedMessage(refusedAt(key))}
                    onChange={(event) => change(key, event.target.value)}
                  />
                ),
              )}
            </Card>
            <ClassificationSection
              categories={form.categories}
              taxCategories={form.taxCategories}
              categoryIds={categoryIds}
              taxCategoryCode={taxCategoryCode}
              defaultLocale={defaultLocale}
              categoryIssues={problem?.categoryIssues}
              onCategories={(ids) => {
                setCategoryIds(ids);
                // The refusals named the old list; they say nothing about this one.
                setProblem((current) =>
                  current?.categoryIssues === undefined
                    ? current
                    : { ...current, categoryIssues: { items: {} } },
                );
                edited();
              }}
              onTax={(code) => {
                setTaxCategoryCode(code);
                edited();
              }}
            >
              {adding ? (
                <p className="text-sm text-fg-muted">{t('catalog.add.later.tags')}</p>
              ) : (
                <TagField
                  ids={topicIds}
                  known={knownTags}
                  defaultLocale={defaultLocale}
                  productId={product.productId}
                  issues={tagIssues}
                  max={maxTags}
                  onMax={setMaxTags}
                  onChange={(ids) => {
                    setTopicIds(ids);
                    // The refusals named the old list; they say nothing about this one.
                    setProblem((current) =>
                      current?.topicIssues === undefined
                        ? current
                        : { ...current, topicIssues: [] },
                    );
                    edited();
                  }}
                />
              )}
            </ClassificationSection>
          </div>
          {add === undefined ? null : (
            <div className="lg:col-start-2 lg:row-start-2">
              <YourOfferCard
                options={add.options}
                typeCode={typeCode}
                conditionCode={conditionCode}
                sellerSku={sellerSku}
                error={(path) => {
                  const key = offerProblem?.fields[path];
                  return key === undefined ? undefined : t(key);
                }}
                onType={(value) => {
                  setTypeCode(value);
                  edited();
                }}
                onCondition={(value) => {
                  setConditionCode(value);
                  edited();
                }}
                onSku={(value) => {
                  setSellerSku(value);
                  edited();
                }}
              />
            </div>
          )}
          <div
            className={`flex min-w-0 flex-col gap-4 lg:col-start-1 ${adding ? 'lg:row-start-4' : 'lg:row-start-3'}`}
          >
            {adding ? (
              <>
                <LaterCard
                  title={t('catalog.edit.attributes')}
                  help={t('catalog.add.later.attributes')}
                />
                <LaterCard
                  title={t('catalog.edit.variants')}
                  help={t('catalog.add.later.variants')}
                />
                <LaterCard
                  title={t('catalog.edit.photos.title')}
                  help={t('catalog.add.later.photos')}
                />
              </>
            ) : (
              <>
                <AttributesSection
                  fields={attributeFields}
                  units={form.units}
                  inputs={inputs}
                  locales={locales}
                  defaultLocale={defaultLocale}
                  refused={refused}
                  productId={product.productId}
                  csrfToken={csrfToken}
                  suggestions={product.suggestions ?? []}
                  onSuggested={() => router.refresh()}
                  onChange={(code: string, value: AttributeInput | undefined) => {
                    setInputs({ ...inputs, [code]: value });
                    setRefused((list) => list.filter((item) => item.ref !== code));
                    edited();
                  }}
                />
                {configurable ? (
                  <VariantsSection
                    rows={rows}
                    fields={form.fields}
                    axes={axes}
                    locked={locked}
                    publishedAxes={publishedAxes}
                    maxAxes={maxAxes}
                    review={product.sensitiveFields.includes('axis-added')}
                    defaultLocale={defaultLocale}
                    locales={locales}
                    max={product.maxVariants}
                    productId={product.productId}
                    galleryIds={imageIds}
                    notices={notices.map((notice) => notice.variantId)}
                    onChange={(next) => {
                      setRows(next.rows);
                      setAxes(next.axes);
                      edited();
                    }}
                  />
                ) : canAddSizes(product, form.fields) ? (
                  <Card title={t('catalog.edit.variants')}>
                    <p className="text-sm text-fg-muted">{t('catalog.addSizes.card-help')}</p>
                    {dirty ? (
                      <p className="text-sm text-fg-muted">{t('catalog.addSizes.save-first')}</p>
                    ) : null}
                    <div>
                      <Button
                        variant="secondary"
                        disabled={dirty || pending}
                        onClick={() => {
                          setSizesRun((run) => run + 1);
                          setSizesOpen(true);
                        }}
                      >
                        {t('catalog.addSizes.start')}
                      </Button>
                    </div>
                  </Card>
                ) : null}
                <AddSizesDialog
                  key={sizesRun}
                  open={sizesOpen}
                  productId={product.productId}
                  version={product.version ?? null}
                  fields={form.fields}
                  maxAxes={maxAxes}
                  waiting={product.pending !== null}
                  defaultLocale={defaultLocale}
                  csrfToken={csrfToken}
                  onClose={() => setSizesOpen(false)}
                  onDone={() => {
                    setSizesOpen(false);
                    router.refresh();
                  }}
                  onStale={() => {
                    setSizesOpen(false);
                    router.refresh();
                  }}
                />
                <PhotosSection
                  productId={product.productId}
                  csrfToken={csrfToken}
                  library={photos}
                  imageIds={imageIds}
                  onImageIds={(ids) => {
                    setImageIds(ids);
                    // A variant can only pick photos the product keeps.
                    setRows((list) =>
                      list.map((row) =>
                        row.imageIds.every((id) => ids.includes(id))
                          ? row
                          : { ...row, imageIds: row.imageIds.filter((id) => ids.includes(id)) },
                      ),
                    );
                    edited();
                  }}
                />
              </>
            )}
          </div>
          <div className={`lg:col-start-2 ${adding ? 'lg:row-start-3' : 'lg:row-start-2'}`}>
            <OrganisationCard
              marketName={marketName}
              typeCode={adding ? typeCode : product.typeCode}
            />
          </div>
        </div>
      </fieldset>
      <SaveBar
        count={dirty ? 1 : 0}
        summary={t(adding ? 'catalog.add.unsaved' : 'catalog.edit.bar.unsaved')}
        errorCount={refused.length}
        errorsSummary={t('catalog.edit.bar.errors', { count: refused.length })}
        saving={pending}
        aboveBottomBar
        labels={{
          region: t('catalog.edit.bar.region'),
          discard: t('catalog.edit.bar.discard'),
          save: t(published ? 'catalog.edit.bar.save-revision' : 'catalog.edit.bar.save-draft'),
          // Every bar says "Saving…" while it saves, as the settings pages do.
          saving: t('settings.bar.saving'),
        }}
        onDiscard={discardChanges}
      />
    </form>
  );
}
