'use client';

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  LoadError,
  RadioGroup,
  Select,
  SkeletonRows,
  TextField,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { languageName } from '../attributes/types.ts';
import {
  API_VARIANT_TYPES,
  ATTRIBUTES_PATH,
  DISPLAY_STYLES,
  OPTION_ORDERS,
  colourOf,
  localesOf,
  nameOf,
  type DisplayStyle,
  type OptionOrder,
  type VariantTypeDetail,
  type VariantTypeSummary,
} from './types.ts';

type Load<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: T }
  | { readonly state: 'missing' }
  | { readonly state: 'failed' };

const ROW =
  'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 text-start hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus';

/**
 * The Variant types tab (variants V6; plan section 9): every variant type of the Market with how
 * buyers choose it, its options, products and live variants, and the languages it lacks; beside it
 * the chosen type's settings. Names, options and labels are edited in Attributes.
 */
export function VariantTypesTab({
  selectedId,
  onSelect,
  canEdit,
  canOpenAttributes,
  csrfToken,
}: {
  readonly selectedId: string | null;
  readonly onSelect: (id: string | null) => void;
  readonly canEdit: boolean;
  readonly canOpenAttributes: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('variants.types');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load<readonly VariantTypeSummary[]>>({ state: 'loading' });

  const fetchTypes = useCallback(async () => {
    setLoad({ state: 'loading' });
    const result = await callApi<{ items: VariantTypeSummary[] }>('GET', API_VARIANT_TYPES);
    if (result.ok) {
      setLoad({ state: 'ready', value: result.body.items });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: 'failed' });
  }, []);

  useEffect(() => {
    void fetchTypes();
  }, [fetchTypes]);

  const types = load.state === 'ready' ? load.value : [];
  const locales = localesOf(types);
  const locale = locales[0] ?? 'en';

  return (
    <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)]">
      <section
        aria-label={t('list-label')}
        className="flex min-w-0 flex-col rounded-lg border border-line bg-surface"
      >
        {load.state === 'loading' ? (
          <div className="p-4">
            <SkeletonRows label={t('loading')} rows={4} />
          </div>
        ) : null}
        {load.state === 'failed' ? (
          <LoadError
            className="flex flex-col items-start gap-3 p-6"
            message={t('load-error')}
            retryLabel={tl('retry')}
            onRetry={() => void fetchTypes()}
          />
        ) : null}
        {load.state === 'ready' && types.length === 0 ? (
          <EmptyState size="compact" icon="columns" title={t('empty')} body={t('empty-body')} />
        ) : null}
        {types.length > 0 ? (
          <ul className="divide-y divide-line" aria-label={t('list-label')}>
            {types.map((type) => {
              const gaps = type.languages.filter((l) => l.nameMissing || l.optionsMissing > 0);
              return (
                <li key={type.id}>
                  <button
                    type="button"
                    aria-current={type.id === selectedId ? 'true' : undefined}
                    onClick={() => onSelect(type.id)}
                    className={`${ROW} ${type.id === selectedId ? 'bg-muted' : ''}`}
                  >
                    <span className="flex min-w-0 flex-wrap items-center gap-2">
                      <span className="font-semibold wrap-anywhere text-fg">
                        {nameOf(type, locale)}
                      </span>
                      {type.status === 'draft' ? (
                        <Badge tone="neutral">{t('status.draft')}</Badge>
                      ) : null}
                    </span>
                    <span className="text-sm whitespace-nowrap text-fg-muted">
                      {t(`display.${type.displayStyle}`)}
                    </span>
                    <span className="col-span-2 text-sm text-fg-muted">
                      {t('counts', {
                        options: type.options,
                        products: type.products,
                        variants: type.liveVariants,
                      })}
                    </span>
                    <span
                      className={`col-span-2 text-sm ${gaps.length === 0 ? 'text-fg-muted' : 'text-attention-fg'}`}
                    >
                      {gaps.length === 0
                        ? t('languages.all')
                        : gaps
                            .map((gap) =>
                              t('languages.missing', {
                                language: languageName(gap.locale, locales),
                                count: gap.optionsMissing + (gap.nameMissing ? 1 : 0),
                              }),
                            )
                            .join(' · ')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
        <p className="border-t border-line px-4 py-3 text-sm text-fg-muted">{t('footnote')}</p>
      </section>
      <VariantTypePanel
        key={selectedId ?? 'none'}
        typeId={selectedId}
        canEdit={canEdit}
        canOpenAttributes={canOpenAttributes}
        csrfToken={csrfToken}
        onSaved={() => void fetchTypes()}
      />
    </div>
  );
}

interface Draft {
  readonly displayStyle: DisplayStyle;
  readonly optionOrder: OptionOrder;
  readonly swatches: Readonly<Record<string, string>>;
  readonly sellerHelp: Readonly<Record<string, string>>;
}

const draftOf = (detail: VariantTypeDetail): Draft => ({
  displayStyle: detail.displayStyle,
  optionOrder: detail.optionOrder,
  swatches: Object.fromEntries(
    detail.optionList.flatMap((option) =>
      option.swatch === null ? [] : [[option.code, option.swatch]],
    ),
  ),
  sellerHelp: { ...detail.sellerHelp },
});

function VariantTypePanel({
  typeId,
  canEdit,
  canOpenAttributes,
  csrfToken,
  onSaved,
}: {
  readonly typeId: string | null;
  readonly canEdit: boolean;
  readonly canOpenAttributes: boolean;
  readonly csrfToken: string;
  readonly onSaved: () => void;
}) {
  const t = useTranslations('variants.types');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load<VariantTypeDetail>>({ state: 'loading' });
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Readonly<Record<string, string>>>({});
  const latest = useRef(0);

  const fetchType = useCallback(async () => {
    if (typeId === null) return;
    const ticket = ++latest.current;
    setLoad({ state: 'loading' });
    const result = await callApi<{ variantType: VariantTypeDetail }>(
      'GET',
      `${API_VARIANT_TYPES}/${encodeURIComponent(typeId)}`,
    );
    if (ticket !== latest.current) return;
    if (result.ok) {
      setLoad({ state: 'ready', value: result.body.variantType });
      setDraft(draftOf(result.body.variantType));
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: result.failure.status === 404 ? 'missing' : 'failed' });
  }, [typeId]);

  useEffect(() => {
    void fetchType();
  }, [fetchType]);

  if (typeId === null) {
    return <EmptyState size="card" icon="columns" title={t('none')} body={t('none-body')} />;
  }
  if (load.state === 'loading' || draft === null) {
    return load.state === 'failed' ? (
      <LoadError
        className="flex flex-col items-start gap-3 rounded-lg border border-line bg-surface p-6"
        message={t('detail-error')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchType()}
      />
    ) : load.state === 'missing' ? (
      <EmptyState size="card" icon="columns" title={t('missing')} />
    ) : (
      <div className="rounded-lg border border-line bg-surface p-4">
        <SkeletonRows label={t('loading')} rows={6} />
      </div>
    );
  }
  if (load.state !== 'ready') return null;
  const detail = load.value;
  const locales = detail.languages.map((language) => language.locale);
  const locale = locales[0] ?? 'en';
  const disabled = !canEdit || saving;
  const changed = JSON.stringify(draft) !== JSON.stringify(draftOf(detail));

  function failureOf(failure: ApiFailure): string {
    if (failure.code === 'variant-type.stale') return t('save.stale');
    if (failure.code === 'attribute.claim-word') return t('save.claim-word');
    if (failure.code === 'access.denied') return t('save.denied');
    if (failure.status === 0 || failure.status >= 500) return t('save.unavailable');
    return t('save.invalid');
  }

  async function save() {
    if (draft === null) return;
    // Swatches are sent (and so checked) only for the Swatches style.
    const bad =
      draft.displayStyle === 'swatches'
        ? Object.entries(draft.swatches).find(([, colour]) => colourOf(colour) === null)
        : undefined;
    if (bad !== undefined) {
      setFieldErrors({ [`swatches.${bad[0]}`]: t('swatch.format') });
      return;
    }
    setSaving(true);
    setProblem(null);
    setFieldErrors({});
    const result = await callApi<unknown>(
      'PUT',
      `${API_VARIANT_TYPES}/${encodeURIComponent(detail.id)}/settings`,
      {
        version: detail.settingsVersion,
        displayStyle: draft.displayStyle,
        optionOrder: draft.optionOrder,
        swatches: draft.displayStyle === 'swatches' ? draft.swatches : {},
        sellerHelp: Object.fromEntries(
          Object.entries(draft.sellerHelp).filter(([, text]) => text.trim() !== ''),
        ),
      },
      csrfToken,
    );
    setSaving(false);
    if (result.ok) {
      toast.success(t('save.done'));
      onSaved();
      void fetchType();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const fields: Record<string, string> = {};
    for (const field of result.failure.details?.fields ?? []) {
      fields[field.path] = field.path.startsWith('swatches.')
        ? t('swatch.format')
        : field.code === 'claim-word'
          ? t('save.claim-word')
          : t('help.invalid');
    }
    setFieldErrors(fields);
    setProblem(failureOf(result.failure));
  }

  return (
    <section
      aria-label={t('detail-label')}
      className="flex min-w-0 flex-col gap-4 rounded-lg border border-line bg-surface p-5"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-xl font-semibold wrap-anywhere">{nameOf(detail, locale)}</h2>
        <Badge tone="info">{t('badge')}</Badge>
        <span className="font-mono text-sm text-fg-muted">{detail.code}</span>
        {canOpenAttributes ? (
          <a
            className="ms-auto text-sm font-medium text-link underline"
            href={`${ATTRIBUTES_PATH}?id=${encodeURIComponent(detail.id)}`}
          >
            {t('edit-in-attributes')}
          </a>
        ) : null}
      </div>
      <p className="text-sm text-fg-muted">{t('intro')}</p>
      {problem === null ? null : (
        <Banner tone="critical" title={t('save.failed')}>
          {problem}
        </Banner>
      )}
      <RadioGroup
        legend={t('display.legend')}
        name="display-style"
        value={draft.displayStyle}
        disabled={disabled}
        onChange={(value) => setDraft({ ...draft, displayStyle: value as DisplayStyle })}
        options={DISPLAY_STYLES.map((style) => ({
          value: style,
          label: t(`display.${style}`),
          help: t(`display.${style}-help`),
        }))}
      />
      <Select
        label={t('order.label')}
        help={t('order.help')}
        value={draft.optionOrder}
        disabled={disabled}
        onChange={(event) => setDraft({ ...draft, optionOrder: event.target.value as OptionOrder })}
        options={OPTION_ORDERS.map((order) => ({ value: order, label: t(`order.${order}`) }))}
      />
      {locales.map((help) => (
        <TextField
          key={help}
          name={`seller-help-${help}`}
          label={t('help.label', { language: languageName(help, locales) })}
          help={t('help.help')}
          value={draft.sellerHelp[help] ?? ''}
          disabled={disabled}
          maxLength={200}
          error={fieldErrors[`sellerHelp.${help}`]}
          dir="auto"
          onChange={(event) =>
            setDraft({ ...draft, sellerHelp: { ...draft.sellerHelp, [help]: event.target.value } })
          }
        />
      ))}
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-semibold text-fg-muted">{t('options.title')}</h3>
        <ul
          className="divide-y divide-line rounded-lg border border-line"
          aria-label={t('options.title')}
        >
          {detail.optionList.map((option) => {
            const colour = draft.swatches[option.code] ?? '';
            const preview = colourOf(colour);
            return (
              <li key={option.code} className="flex flex-col gap-2 px-3 py-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="font-medium text-fg">
                    {option.labels[locale] ?? option.code}
                  </span>
                  {locales.slice(1).map((other) => (
                    <span key={other} dir="auto" className="text-sm text-fg-muted">
                      {option.labels[other] ?? (
                        <span className="text-attention-fg">
                          {t('options.missing', { language: languageName(other, locales) })}
                        </span>
                      )}
                    </span>
                  ))}
                  {option.active ? null : <Badge tone="neutral">{t('options.inactive')}</Badge>}
                  <span className="ms-auto text-sm text-fg-muted">
                    {t('options.products', { count: option.products })}
                  </span>
                </div>
                {draft.displayStyle === 'swatches' ? (
                  <div className="flex items-end gap-2">
                    <span
                      aria-hidden="true"
                      className="mb-2 size-6 shrink-0 rounded-full border border-line"
                      style={preview === null ? undefined : { backgroundColor: preview }}
                    />
                    <TextField
                      name={`swatch-${option.code}`}
                      label={t('swatch.label', { option: option.labels[locale] ?? option.code })}
                      value={colour}
                      placeholder={t('swatch.placeholder')}
                      disabled={disabled}
                      maxLength={7}
                      autoComplete="off"
                      error={fieldErrors[`swatches.${option.code}`]}
                      onChange={(event) => {
                        const swatches = { ...draft.swatches };
                        if (event.target.value === '') delete swatches[option.code];
                        else swatches[option.code] = event.target.value;
                        setDraft({ ...draft, swatches });
                      }}
                    />
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
      {canEdit ? (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="secondary"
            disabled={!changed || saving}
            onClick={() => {
              setDraft(draftOf(detail));
              setFieldErrors({});
              setProblem(null);
            }}
          >
            {t('save.discard')}
          </Button>
          <Button loading={saving} disabled={!changed || saving} onClick={() => void save()}>
            {t('save.label')}
          </Button>
        </div>
      ) : null}
    </section>
  );
}
