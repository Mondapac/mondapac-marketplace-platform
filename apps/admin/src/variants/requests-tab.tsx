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
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { When } from '../shared/when.tsx';
import {
  API_REQUESTS,
  describeOptions,
  type RequestDecided,
  type RequestItem,
  type RequestList,
} from './types.ts';

const REASON_MAX = 300;

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly value: RequestList }
  | { readonly state: 'denied' }
  | { readonly state: 'failed' };

/** A message key under `variants.requests.error` for a refused decision. */
const BY_CODE: Readonly<Record<string, { key: string; reload: boolean }>> = {
  'validation.failed': { key: 'invalid', reload: false },
  'variant-request.stale': { key: 'stale', reload: true },
  'variant-request.not-open': { key: 'stale', reload: true },
  'variant-request.not-found': { key: 'stale', reload: true },
  'variant-request.variant-exists': { key: 'variant-exists', reload: true },
  'variant-request.variant-unknown': { key: 'variant-unknown', reload: true },
  'variant-request.product-unavailable': { key: 'product-unavailable', reload: false },
  'variant-request.draft-unavailable': { key: 'draft-unavailable', reload: false },
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
 * The Waiting for you tab (variants V7): sizes that sellers asked for on a platform product.
 * The request holds option codes only, named here from the Market's catalogue, never a seller's
 * words. An administrator with the review key approves it (a proposed variant joins the product's
 * draft and goes through the normal review), maps it to a variant the product already has, or
 * declines it with a reason the seller reads in an email.
 */
export function RequestsTab({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('variants.requests');
  return (
    <section aria-labelledby="requests-heading" className="flex flex-col gap-4">
      <h2 id="requests-heading" className="text-lg font-semibold text-fg">
        {t('title')}
      </h2>
      <RequestsBody csrfToken={csrfToken} />
    </section>
  );
}

function RequestsBody({ csrfToken }: { readonly csrfToken: string }) {
  const t = useTranslations('variants.requests');
  const tl = useTranslations('load');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [notice, setNotice] = useState<string | null>(null);

  // The first read shows the skeleton; a later read keeps the list on screen and replaces it.
  const fetchList = useCallback(async (quiet = false) => {
    if (!quiet) setLoad({ state: 'loading' });
    const result = await callApi<RequestList>('GET', API_REQUESTS);
    if (result.ok) {
      setLoad({ state: 'ready', value: result.body });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (quiet) {
      setNotice('reload-failed');
      return;
    }
    setLoad({ state: result.failure.status === 403 ? 'denied' : 'failed' });
  }, []);

  useEffect(() => {
    void fetchList();
  }, [fetchList]);

  if (load.state === 'denied') {
    return (
      <Banner tone="info" title={t('denied-title')}>
        {t('denied-body')}
      </Banner>
    );
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
  const { items } = load.value;
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
            <RequestCard
              item={item}
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

type Mode = 'none' | 'approve' | 'map' | 'decline';

function RequestCard({
  item,
  csrfToken,
  onSettled,
}: {
  readonly item: RequestItem;
  readonly csrfToken: string;
  /** The list is read again; `why` is an error key to tell the admin, after a refused decision. */
  readonly onSettled: (why?: string) => void;
}) {
  const t = useTranslations('variants.requests');
  const busy = useRef(false);
  const card = useRef<HTMLElement>(null);
  const opened = useRef(false);
  const [mode, setMode] = useState<Mode>('none');
  const [variantId, setVariantId] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<{ key: string; reload: boolean } | null>(null);

  const asked = describeOptions(item.options);

  async function decide(action: Exclude<Mode, 'none'>, body: Record<string, unknown>) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<RequestDecided>(
      'POST',
      `${API_REQUESTS}/${item.id}/${action}`,
      { version: item.version, ...body },
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    if (result.ok) {
      toast.success(t(`decided.${result.body.request.status}`));
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
      card.current?.querySelector<HTMLElement>('form select, form textarea, form button')?.focus();
    } else if (opened.current) {
      opened.current = false;
      card.current?.querySelector<HTMLElement>('button')?.focus();
    }
  }, [mode]);

  return (
    <section ref={card} className="rounded-lg border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 text-base font-semibold wrap-anywhere text-fg">{asked}</h3>
        <Badge tone="attention">{t('open')}</Badge>
      </div>
      <p className="mt-1 text-sm text-fg-muted">
        {t('asked', {
          product: item.productCode ?? t('no-product-code'),
          seller: item.sellerName ?? t('unnamed-seller'),
        })}{' '}
        <When iso={item.createdAt} missing="" />
      </p>
      {item.alreadyExists ? (
        <div className="mt-3">
          <Banner tone="info">{t('already-exists')}</Banner>
        </div>
      ) : null}
      {problem === null ? null : (
        <div className="mt-3" role="alert">
          <Banner tone="critical">{t(`error.${problem.key}`)}</Banner>
        </div>
      )}
      {mode === 'none' ? (
        <div className="mt-3 flex flex-wrap gap-3">
          <Button
            aria-label={t('approve-for', { asked })}
            disabled={item.alreadyExists}
            onClick={() => setMode('approve')}
          >
            {t('approve')}
          </Button>
          <Button
            variant="secondary"
            aria-label={t('map-for', { asked })}
            disabled={item.existing.length === 0}
            onClick={() => setMode('map')}
          >
            {t('map')}
          </Button>
          <Button
            variant="secondary"
            aria-label={t('decline-for', { asked })}
            onClick={() => setMode('decline')}
          >
            {t('decline')}
          </Button>
          {item.existing.length === 0 ? (
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
            void decide('approve', {});
          }}
        >
          <p className="text-sm text-fg-muted">{t('approve-note')}</p>
          <Actions
            busy={pending}
            disabled={false}
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
            void decide('map', { variantId });
          }}
        >
          <div className="w-full sm:w-96">
            <Select
              label={t('map-to')}
              placeholder={t('map-choose')}
              value={variantId}
              options={item.existing.map((variant) => ({
                value: variant.variantId,
                label: describeOptions(variant.options) || `#${variant.variantNo}`,
              }))}
              onChange={(event) => setVariantId(event.target.value)}
            />
          </div>
          <Actions
            busy={pending}
            disabled={variantId === ''}
            confirm={t('map-confirm')}
            onCancel={() => setMode('none')}
          />
        </form>
      ) : null}
      {mode === 'decline' ? (
        <form
          className="mt-3 flex flex-col gap-3"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void decide('decline', { reason: reason.trim() });
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
            confirm={t('decline-confirm')}
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
  const t = useTranslations('variants.requests');
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
