'use client';

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  LoadError,
  Select,
  SkeletonRows,
  TextAreaField,
  TextField,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { When } from '../shared/when.tsx';
import {
  API_SUGGESTIONS,
  directionOf,
  languageName,
  textIn,
  type SuggestionDecided,
  type SuggestionItem,
  type SuggestionList,
} from './types.ts';

const LABEL_MAX = 120;
const REASON_MAX = 300;

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: SuggestionList }
  | { readonly state: 'denied' }
  | { readonly state: 'failed' };

/** A message key under `attributes.suggestions.error` for a refused decision. */
const BY_CODE: Readonly<Record<string, { key: string; reload: boolean }>> = {
  'validation.failed': { key: 'invalid', reload: false },
  'attribute-definition.default-label-required': { key: 'invalid', reload: false },
  'suggestion.stale': { key: 'stale', reload: true },
  'suggestion.not-open': { key: 'stale', reload: true },
  'suggestion.not-found': { key: 'stale', reload: true },
  'suggestion.attribute-unavailable': { key: 'attribute-unavailable', reload: true },
  'suggestion.value-exists': { key: 'value-exists', reload: false },
  'suggestion.option-invalid': { key: 'option-invalid', reload: true },
  'suggestion.reason-invalid': { key: 'invalid', reload: false },
  'access.denied': { key: 'denied', reload: false },
  'request.throttled': { key: 'throttled', reload: false },
  'request.csrf': { key: 'csrf', reload: false },
};

function problemOf(failure: ApiFailure): { key: string; reload: boolean } {
  const known = BY_CODE[failure.code];
  if (known !== undefined) return known;
  // A claim-word refusal of a label names its own code family; anything unknown is shown plainly.
  if (failure.code.startsWith('claim.')) return { key: 'claim', reload: false };
  return {
    key: failure.status === 0 || failure.status >= 500 ? 'unavailable' : 'unknown',
    reload: false,
  };
}

/**
 * The Waiting for you tab (attributes A5): value suggestions that sellers made on select fields.
 * The seller's words are plain text. An administrator with the decide key approves the value
 * (named in every required language), maps it to a value the field already has, or rejects it
 * with a reason the seller reads in an email. Nothing is decided by itself.
 */
export function SuggestionsTab({
  canDecide,
  csrfToken,
}: {
  readonly canDecide: boolean;
  readonly csrfToken: string;
}) {
  const t = useTranslations('attributes.suggestions');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>(canDecide ? { state: 'loading' } : { state: 'denied' });

  const fetchList = useCallback(async () => {
    setLoad({ state: 'loading' });
    const result = await callApi<SuggestionList>('GET', API_SUGGESTIONS);
    if (result.ok) {
      setLoad({ state: 'ready', value: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: result.failure.status === 403 ? 'denied' : 'failed' });
  }, []);

  useEffect(() => {
    if (canDecide) void fetchList();
  }, [canDecide, fetchList]);

  if (load.state === 'denied') {
    return <p className="text-fg-muted">{t('no-access')}</p>;
  }
  if (load.state === 'loading') return <SkeletonRows label={t('loading')} rows={3} />;
  if (load.state === 'failed') {
    return (
      <LoadError
        message={t('load-failed')}
        retryLabel={tl('retry')}
        onRetry={() => void fetchList()}
      />
    );
  }
  const { items, requiredLocales, locales } = load.value;
  if (items.length === 0) {
    return <EmptyState size="card" icon="inbox" title={t('empty')} body={t('empty-body')} />;
  }
  return (
    <ul className="flex flex-col gap-4" aria-label={t('list-label')}>
      {items.map((item) => (
        <li key={`${item.id}:${item.version}`}>
          <SuggestionCard
            item={item}
            requiredLocales={requiredLocales}
            defaultLocale={locales.default}
            supported={locales.supported}
            csrfToken={csrfToken}
            onSettled={() => void fetchList()}
          />
        </li>
      ))}
    </ul>
  );
}

type Mode = 'none' | 'approve' | 'map' | 'reject';

function SuggestionCard({
  item,
  requiredLocales,
  defaultLocale,
  supported,
  csrfToken,
  onSettled,
}: {
  readonly item: SuggestionItem;
  readonly requiredLocales: readonly string[];
  readonly defaultLocale: string;
  readonly supported: readonly string[];
  readonly csrfToken: string;
  readonly onSettled: () => void;
}) {
  const t = useTranslations('attributes.suggestions');
  const [mode, setMode] = useState<Mode>('none');
  const [labels, setLabels] = useState<Record<string, string>>({ [defaultLocale]: item.label });
  const [optionCode, setOptionCode] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ key: string; reload: boolean } | null>(null);

  const attributeName = textIn(
    item.attribute.names,
    defaultLocale,
    defaultLocale,
    item.attribute.code,
  );
  const locales = requiredLocales.length === 0 ? [defaultLocale] : requiredLocales;

  async function decide(action: Mode, body: Record<string, unknown>) {
    if (busy || action === 'none') return;
    setBusy(true);
    setProblem(null);
    const result = await callApi<SuggestionDecided>(
      'POST',
      `${API_SUGGESTIONS}/${item.id}/${action}`,
      { version: item.version, ...body },
      csrfToken,
    );
    setBusy(false);
    if (result.ok) {
      toast.success(t(`decided.${result.body.suggestion.status}`));
      onSettled();
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const next = problemOf(result.failure);
    setProblem(next);
    if (next.reload) onSettled();
  }

  const missing = locales.some((locale) => (labels[locale] ?? '').trim() === '');
  return (
    <section className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-base font-semibold wrap-anywhere text-fg">“{item.label}”</h3>
        <Badge tone="attention">{t('open')}</Badge>
      </div>
      <p className="mt-1 text-sm text-fg-muted">
        {t('asked', {
          attribute: attributeName,
          product: item.productCode ?? t('no-product-code'),
        })}{' '}
        <When iso={item.createdAt} missing="" />
      </p>
      {problem === null ? null : (
        <div className="mt-3">
          <Banner tone="critical">{t(`error.${problem.key}`)}</Banner>
        </div>
      )}
      {mode === 'none' ? (
        <div className="mt-3 flex flex-wrap gap-3">
          <Button onClick={() => setMode('approve')}>{t('approve')}</Button>
          <Button
            variant="secondary"
            disabled={item.attribute.options.length === 0}
            onClick={() => setMode('map')}
          >
            {t('map')}
          </Button>
          <Button variant="secondary" onClick={() => setMode('reject')}>
            {t('reject')}
          </Button>
        </div>
      ) : null}
      {mode === 'approve' ? (
        <form
          className="mt-3 flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            const sent: Record<string, string> = {};
            for (const locale of locales) sent[locale] = (labels[locale] ?? '').trim();
            void decide('approve', { labels: sent });
          }}
        >
          <p className="text-sm text-fg-muted">{t('approve-note')}</p>
          {locales.map((locale) => (
            <TextField
              key={locale}
              name={`label-${locale}`}
              label={t('name-in', { language: languageName(locale, supported) })}
              value={labels[locale] ?? ''}
              maxLength={LABEL_MAX}
              lang={locale}
              dir={directionOf(locale)}
              autoComplete="off"
              onChange={(event) => setLabels({ ...labels, [locale]: event.target.value })}
            />
          ))}
          <Actions
            busy={busy}
            disabled={missing}
            confirm={t('approve-confirm')}
            onCancel={() => setMode('none')}
          />
        </form>
      ) : null}
      {mode === 'map' ? (
        <form
          className="mt-3 flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void decide('map', { optionCode });
          }}
        >
          <div className="w-full sm:w-72">
            <Select
              label={t('map-to')}
              placeholder={t('map-choose')}
              value={optionCode}
              options={item.attribute.options.map((option) => ({
                value: option.code,
                label: textIn(option.labels, defaultLocale, defaultLocale, option.code),
              }))}
              onChange={(event) => setOptionCode(event.target.value)}
            />
          </div>
          <Actions
            busy={busy}
            disabled={optionCode === ''}
            confirm={t('map-confirm')}
            onCancel={() => setMode('none')}
          />
        </form>
      ) : null}
      {mode === 'reject' ? (
        <form
          className="mt-3 flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void decide('reject', { reason: reason.trim() });
          }}
        >
          <TextAreaField
            name="reason"
            label={t('reason')}
            help={t('reason-help')}
            rows={3}
            value={reason}
            maxLength={REASON_MAX}
            counter={`${reason.length} / ${REASON_MAX}`}
            onChange={(event) => setReason(event.target.value)}
          />
          <Actions
            busy={busy}
            disabled={reason.trim() === ''}
            confirm={t('reject-confirm')}
            onCancel={() => setMode('none')}
          />
        </form>
      ) : null}
    </section>
  );
}

function Actions({
  busy,
  disabled,
  confirm,
  onCancel,
}: {
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly confirm: string;
  readonly onCancel: () => void;
}) {
  const t = useTranslations('attributes.suggestions');
  return (
    <div className="flex flex-wrap gap-3">
      <Button type="submit" loading={busy} disabled={busy || disabled}>
        {confirm}
      </Button>
      <Button type="button" variant="secondary" disabled={busy} onClick={onCancel}>
        {t('cancel')}
      </Button>
    </div>
  );
}
