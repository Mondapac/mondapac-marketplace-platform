'use client';

import {
  Badge,
  Banner,
  Button,
  Dialog,
  EmptyState,
  LoadError,
  SkeletonRows,
  toast,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { When } from '../shared/when.tsx';
import { useAttributeCall } from './use-attribute-call.ts';
import { API_RELAXATIONS, type OpenRelaxation, type OpenRelaxationList } from './types.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly requests: readonly OpenRelaxation[] }
  | { readonly state: 'failed' };

type Pending = { readonly kind: 'confirm' | 'withdraw'; readonly request: OpenRelaxation } | null;

/** The attribute's name in the panel's language, else any name it has, else its code. */
function nameOf(request: OpenRelaxation, locale: string): string {
  const names = request.attribute.names;
  return (
    names[locale] ??
    names[locale.split('-')[0] ?? locale] ??
    Object.values(names)[0] ??
    request.attribute.code
  );
}

/**
 * The Waiting for you tab (attributes A2 part 3): requests to turn off Material that wait for a
 * second administrator, soonest to expire first. Another administrator's request can be
 * confirmed; the reader's own can be withdrawn. Both ask first. Only an admin with
 * `catalog.attribute.edit` reads the list; any other admin sees the empty state.
 */
export function WaitingTab({
  canEdit,
  csrfToken,
  onOpenAttribute,
}: {
  readonly canEdit: boolean;
  readonly csrfToken: string;
  readonly onOpenAttribute: (attributeId: string) => void;
}) {
  const t = useTranslations('attributes.waiting');
  const tl = useTranslations('load');
  const locale = useLocale();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [pending, setPending] = useState<Pending>(null);

  const fetchRequests = useCallback(async () => {
    setLoad({ state: 'loading' });
    const result = await callApi<OpenRelaxationList>('GET', API_RELAXATIONS);
    if (result.ok) {
      setLoad({ state: 'ready', requests: result.body.requests });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: 'failed' });
  }, []);

  useEffect(() => {
    if (canEdit) void fetchRequests();
  }, [canEdit, fetchRequests]);

  const empty = <EmptyState size="card" icon="inbox" title={t('empty')} body={t('body')} />;
  if (!canEdit) return empty;

  return (
    <section
      aria-label={t('label')}
      aria-busy={load.state === 'loading'}
      className="flex min-w-0 flex-col gap-3"
    >
      {load.state === 'loading' ? <SkeletonRows label={t('loading')} rows={3} /> : null}
      {load.state === 'failed' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('load-error')}
          retryLabel={tl('retry')}
          onRetry={() => void fetchRequests()}
        />
      ) : null}
      {load.state === 'ready' && load.requests.length === 0 ? empty : null}
      {load.state === 'ready' && load.requests.length > 0 ? (
        <ul className="flex flex-col divide-y divide-line rounded-lg border border-line bg-surface">
          {load.requests.map((request) => {
            const name = nameOf(request, locale);
            return (
              <li
                key={request.id}
                className="flex flex-wrap items-start justify-between gap-3 px-4 py-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium wrap-anywhere text-fg">{name}</span>
                    <Badge tone="attention">{t(`kind.${request.kind}`)}</Badge>
                    {request.mine ? <Badge tone="neutral">{t('mine')}</Badge> : null}
                  </div>
                  <p className="text-sm wrap-anywhere text-fg-muted">{request.attribute.code}</p>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                    <dt className="text-fg-muted">{t('requested')}</dt>
                    <dd>
                      <When iso={request.requestedAt} missing="" />
                    </dd>
                    <dt className="text-fg-muted">{t('expires')}</dt>
                    <dd>
                      <When iso={request.expiresAt} missing="" />
                    </dd>
                  </dl>
                  {request.mine ? (
                    <p className="text-sm text-fg-muted">{t('same-admin-note')}</p>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => onOpenAttribute(request.attribute.id)}>
                    {t('open-attribute')}
                  </Button>
                  {request.allowedActions.confirm.allowed ? (
                    <Button onClick={() => setPending({ kind: 'confirm', request })}>
                      {t('confirm')}
                    </Button>
                  ) : null}
                  {request.allowedActions.cancel.allowed ? (
                    <Button
                      variant="destructive"
                      onClick={() => setPending({ kind: 'withdraw', request })}
                    >
                      {t('withdraw')}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {pending === null ? null : (
        <DecisionDialog
          kind={pending.kind}
          request={pending.request}
          name={nameOf(pending.request, locale)}
          csrfToken={csrfToken}
          onClose={() => setPending(null)}
          onDone={() => {
            toast.success(t(pending.kind === 'confirm' ? 'confirmed' : 'withdrawn'));
            setPending(null);
            void fetchRequests();
          }}
          onReload={() => {
            setPending(null);
            void fetchRequests();
          }}
        />
      )}
    </section>
  );
}

/** Confirm another admin's request, or withdraw the reader's own, after the admin agrees. */
function DecisionDialog({
  kind,
  request,
  name,
  csrfToken,
  onClose,
  onDone,
  onReload,
}: {
  readonly kind: 'confirm' | 'withdraw';
  readonly request: OpenRelaxation;
  readonly name: string;
  readonly csrfToken: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
  readonly onReload: () => void;
}) {
  const t = useTranslations('attributes.waiting');
  const te = useTranslations('attributes.editor');
  const call = useAttributeCall(csrfToken);
  const action = kind === 'confirm' ? 'confirm' : 'cancel';

  async function decide() {
    const answer = await call.run(
      'POST',
      `${API_RELAXATIONS}/${encodeURIComponent(request.id)}/${action}`,
      { version: request.version },
    );
    if (answer.ok) onDone();
  }

  const problem = call.problem;
  return (
    <Dialog
      open
      title={t(`${kind}-title`, { name })}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" disabled={call.pending} onClick={onClose}>
            {t('cancel')}
          </Button>
          {problem?.reload === true ? (
            <Button onClick={onReload}>{t('reload')}</Button>
          ) : (
            <Button
              variant={kind === 'withdraw' ? 'destructive-solid' : 'primary'}
              loading={call.pending}
              disabled={call.pending}
              onClick={() => void decide()}
            >
              {t(kind)}
            </Button>
          )}
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {problem === null ? null : <Banner tone="critical">{te(`error.${problem.key}`)}</Banner>}
        <p>{t(`${kind}-body`)}</p>
      </div>
    </Dialog>
  );
}
