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
import { useCallback, useEffect, useRef, useState } from 'react';
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
const CODE_RE = /^[a-z][a-z0-9-]{0,62}$/;

/** Whether the words give a code by themselves (the API makes it from Latin letters and digits). */
const hasLatin = (text: string): boolean => /[a-z0-9]/i.test(text.normalize('NFKD'));
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
  'suggestion.attribute-protected': { key: 'attribute-unavailable', reload: true },
  'suggestion.label-invalid': { key: 'invalid', reload: false },
  'attribute-definition.not-published': { key: 'attribute-unavailable', reload: true },
  'attribute-definition.archived': { key: 'attribute-unavailable', reload: true },
  'attribute-definition.option-repeated': { key: 'value-exists', reload: false },
  'attribute.claim-word': { key: 'claim', reload: false },
  'attribute.locale-uncheckable': { key: 'locale-uncheckable', reload: false },
  'claim-text.check-unavailable': { key: 'check-unavailable', reload: false },
  'suggestion.option-invalid': { key: 'option-invalid', reload: true },
  'suggestion.reason-invalid': { key: 'invalid', reload: false },
  'access.denied': { key: 'denied', reload: false },
  'request.throttled': { key: 'throttled', reload: false },
  'request.csrf': { key: 'csrf', reload: false },
};

function problemOf(failure: ApiFailure): { key: string; reload: boolean } {
  const known = BY_CODE[failure.code];
  if (known !== undefined) return known;
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

  const [notice, setNotice] = useState<string | null>(null);

  // The first read shows the skeleton; a later read keeps the list on screen and replaces it in place.
  const fetchList = useCallback(async (quiet = false) => {
    if (!quiet) setLoad({ state: 'loading' });
    const result = await callApi<SuggestionList>('GET', API_SUGGESTIONS);
    if (result.ok) {
      setLoad({ state: 'ready', value: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (quiet) return;
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
  const banner =
    notice === null ? null : (
      <div role="alert">
        <Banner tone="info">{t(`error.${notice}`)}</Banner>
      </div>
    );
  if (items.length === 0) {
    return (
      <div className="flex flex-col gap-4">
        {banner}
        <EmptyState size="card" icon="inbox" title={t('empty')} body={t('empty-body')} />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4">
      {banner}
      <ul className="flex flex-col gap-4" aria-label={t('list-label')}>
        {items.map((item) => (
          <li key={`${item.id}:${item.version}`}>
            <SuggestionCard
              item={item}
              requiredLocales={requiredLocales}
              defaultLocale={locales.default}
              supported={locales.supported}
              csrfToken={csrfToken}
              onSettled={(why) => {
                setNotice(why ?? null);
                void fetchList(true);
              }}
            />
          </li>
        ))}
      </ul>
    </div>
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
  /** The list is read again; `why` is an error key to tell the admin, after a refused decision. */
  readonly onSettled: (why?: string) => void;
}) {
  const t = useTranslations('attributes.suggestions');
  const busy = useRef(false);
  const card = useRef<HTMLElement>(null);
  const opened = useRef(false);
  const [mode, setMode] = useState<Mode>('none');
  const [labels, setLabels] = useState<Record<string, string>>({ [defaultLocale]: item.label });
  const [optionCode, setOptionCode] = useState('');
  const [newCode, setNewCode] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{ key: string; reload: boolean } | null>(null);

  const attributeName = textIn(
    item.attribute.names,
    defaultLocale,
    defaultLocale,
    item.attribute.code,
  );
  const locales = requiredLocales.length === 0 ? [defaultLocale] : requiredLocales;

  async function decide(action: Mode, body: Record<string, unknown>) {
    if (busy.current || action === 'none') return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<SuggestionDecided>(
      'POST',
      `${API_SUGGESTIONS}/${item.id}/${action}`,
      { version: item.version, ...body },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
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
    // A stale card goes away with its list refresh, so the reason is told above the list.
    if (next.reload) onSettled(next.key);
    else setProblem(next);
  }

  // Opening a form moves focus to its first field; cancelling returns it to the first action.
  useEffect(() => {
    if (mode !== 'none') {
      opened.current = true;
      card.current?.querySelector<HTMLElement>('form input, form select, form textarea')?.focus();
    } else if (opened.current) {
      opened.current = false;
      card.current?.querySelector<HTMLElement>('button')?.focus();
    }
  }, [mode]);

  const codeNeeded = !hasLatin(labels[defaultLocale] ?? '');
  const codeBad = newCode !== '' && !CODE_RE.test(newCode);
  const missing =
    codeBad ||
    (codeNeeded && newCode === '') ||
    locales.some((locale) => (labels[locale] ?? '').trim() === '');
  return (
    <section ref={card} className="rounded-lg border border-line bg-surface p-4">
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
          <Button
            aria-label={t('approve-for', { label: item.label })}
            onClick={() => setMode('approve')}
          >
            {t('approve')}
          </Button>
          <Button
            variant="secondary"
            aria-label={t('map-for', { label: item.label })}
            disabled={item.attribute.options.length === 0}
            onClick={() => setMode('map')}
          >
            {t('map')}
          </Button>
          <Button
            variant="secondary"
            aria-label={t('reject-for', { label: item.label })}
            onClick={() => setMode('reject')}
          >
            {t('reject')}
          </Button>
          {item.attribute.options.length === 0 ? (
            <p className="basis-full text-sm text-fg-muted">{t('map-none')}</p>
          ) : null}
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
            void decide('approve', {
              labels: sent,
              ...(newCode === '' ? {} : { optionCode: newCode }),
            });
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
          <TextField
            name="option-code"
            label={t('value-code')}
            help={codeNeeded ? t('value-code-needed') : t('value-code-help')}
            value={newCode}
            maxLength={63}
            dir="ltr"
            autoComplete="off"
            error={codeBad ? t('value-code-bad') : undefined}
            onChange={(event) => setNewCode(event.target.value.trim().toLowerCase())}
          />
          <Actions
            busy={pending}
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
            busy={pending}
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
            dir="auto"
            counter={`${reason.length} / ${REASON_MAX}`}
            onChange={(event) => setReason(event.target.value)}
          />
          <Actions
            busy={pending}
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
