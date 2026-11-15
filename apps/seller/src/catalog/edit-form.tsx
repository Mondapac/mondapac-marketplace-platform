'use client';

import {
  BackLink,
  Banner,
  Button,
  Card,
  DescriptionWriter,
  TextField,
  UnsavedBar,
  toast,
  useUnsavedChangesGuard,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { callApi } from '../api/client.ts';
import { AddSizesDialog } from './add-sizes-dialog.tsx';
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
import { editProblemOf, type EditProblem } from './edit-errors.ts';
import { DEFAULT_MAX_TAGS, TagField, topicSentences, useKnownTags } from './tag-field.tsx';
import { OrganisationCard, StatusBadge, StatusCard, type Blocker } from './product-side.tsx';
import { writerCategory, writerDetails } from './writer-inputs.ts';
import { VariantsSection } from './variants-section.tsx';
import { hasProblems, problemsOfRows } from './variant-fields.ts';
import { axesOf } from './variant-grid.ts';
import type { DraftSaved, ProductPhoto, ProductView, Submitted } from './types.ts';

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
}: {
  readonly product: ProductView;
  /** The product's photo library, or `null` when it could not be read. */
  readonly photos: readonly ProductPhoto[] | null;
  readonly locales: readonly string[];
  readonly defaultLocale: string;
  readonly marketName: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations();
  const locale = useLocale();
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
  const shownTitle = savedName === '' ? t('catalog.edit.page.untitled') : savedName;
  const published = product.published !== null;
  // Leaving with edits that are not saved asks first (the same dialog the settings pages use).
  const guard = useUnsavedChangesGuard(dirty, {
    title: t('catalog.edit.leave.title'),
    message:
      savedName === ''
        ? t('catalog.edit.leave.message-untitled')
        : t('catalog.edit.leave.message', { title: savedName }),
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
  if (form.categories.length > 0 && categoryIds.length === 0) missing.push('category');
  if (form.taxCategoryCodes.length > 0 && taxCategoryCode === '') missing.push('tax');
  if (attributeFields.some((field) => field.required && !filled(inputs[field.code]))) {
    missing.push('details');
  }
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

  async function run(action: 'save' | 'submit') {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
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
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      {guard.dialog}
      {dirty ? (
        <UnsavedBar
          region={t('catalog.edit.bar.region')}
          label={
            refused.length > 0
              ? t('catalog.edit.bar.errors', { count: refused.length })
              : t('catalog.edit.bar.unsaved')
          }
          error={refused.length > 0}
          discardLabel={t('catalog.edit.bar.discard')}
          saveLabel={t(
            published ? 'catalog.edit.bar.save-revision' : 'catalog.edit.bar.save-draft',
          )}
          saving={pending}
          onDiscard={discardChanges}
        />
      ) : null}
      <BackLink href={`/products/${product.productId}`} label={t('catalog.edit.back')} />
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="min-w-0 break-words text-2xl font-semibold">{shownTitle}</h1>
          <StatusBadge status={product.status} />
        </div>
        <p className="text-sm text-fg-muted">
          {t('catalog.edit.page.subtitle', { market: marketName, code: product.productCode })}
        </p>
      </div>
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
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_21.25rem] lg:grid-rows-[auto_1fr] lg:items-start">
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
        <div className="flex min-w-0 flex-col gap-4 lg:col-start-1 lg:row-span-2 lg:row-start-1">
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
            {KEYS.map((key) => (
              <TextField
                key={key}
                name={key}
                label={t(`catalog.edit.field.${key}`)}
                {...(key === 'name' ? { help: t('catalog.edit.field.name-help') } : {})}
                optionalLabel={key === 'name' ? undefined : t('catalog.create.optional')}
                {...(key === 'description'
                  ? {
                      headAction: (
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
                      ),
                    }
                  : {})}
                value={texts[key]}
                error={refusedMessage(refusedAt(key))}
                onChange={(event) => change(key, event.target.value)}
              />
            ))}
          </Card>
          <ClassificationSection
            categories={form.categories}
            taxCategoryCodes={form.taxCategoryCodes}
            categoryIds={categoryIds}
            taxCategoryCode={taxCategoryCode}
            defaultLocale={defaultLocale}
            onCategories={(ids) => {
              setCategoryIds(ids);
              edited();
            }}
            onTax={(code) => {
              setTaxCategoryCode(code);
              edited();
            }}
          >
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
                  current?.topicIssues === undefined ? current : { ...current, topicIssues: [] },
                );
                edited();
              }}
            />
          </ClassificationSection>
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
        </div>
        <div className="flex flex-col gap-4 lg:col-start-2 lg:row-start-2">
          <OrganisationCard marketName={marketName} typeCode={product.typeCode} />
        </div>
      </div>
    </form>
  );
}
