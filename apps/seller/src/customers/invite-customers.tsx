'use client';

import {
  Banner,
  Button,
  Card,
  ConfirmAction,
  EmptyState,
  LoadError,
  Spinner,
  TextField,
  toast,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callApi, type ApiFailure } from '../api/client.ts';
import { InviteQr, downloadQrPng } from './invite-qr.tsx';
import type { InviteLinkAnswer } from './types.ts';

const PATH = 'customers/seller/invite-link';

/** The storefront address of an invite: its origin (from the panel's config) and the token. */
export function inviteUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/invite/${token}`;
}

type Problem =
  { readonly kind: 'throttled'; readonly minutes: number } | { readonly kind: 'failed' };

function problemOf(failure: ApiFailure): Problem {
  if (failure.status === 429) {
    const seconds = failure.details?.retryAfterSeconds ?? 60;
    return { kind: 'throttled', minutes: Math.max(1, Math.ceil(seconds / 60)) };
  }
  return { kind: 'failed' };
}

/**
 * Settings, Invite customers: the shop's invite link (read-only field, Copy link, a QR code drawn
 * in the browser and a PNG download), Refresh link… (the old link and its QR stop working at once;
 * customers who joined stay the shop's) and how many customers joined through the links. Each card
 * fails on its own with Try again. The count is a total of counted and not counted sign-ups, with a
 * hint when some were not counted.
 */
export function InviteCustomers({
  storefrontOrigin,
  csrfToken,
}: {
  /** The storefront's origin from the panel's config; null when it is not set. */
  readonly storefrontOrigin: string | null;
  readonly csrfToken: string;
}) {
  const t = useTranslations('customers.invite');
  const tl = useTranslations('load');
  const [answer, setAnswer] = useState<InviteLinkAnswer | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [denied, setDenied] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [working, setWorking] = useState(false);
  const [refreshProblem, setRefreshProblem] = useState<string | null>(null);
  const fieldRef = useRef<HTMLDivElement>(null);
  const busy = useRef(false);

  const load = useCallback(async () => {
    setProblem(null);
    const result = await callApi<InviteLinkAnswer>('GET', PATH);
    if (result.ok) {
      setAnswer(result.body);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    if (result.failure.status === 403) {
      setDenied(true);
      return;
    }
    setProblem(problemOf(result.failure));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function refresh() {
    if (busy.current) return;
    busy.current = true;
    setWorking(true);
    setRefreshProblem(null);
    const result = await callApi<InviteLinkAnswer>('POST', `${PATH}/refresh`, undefined, csrfToken);
    busy.current = false;
    setWorking(false);
    if (result.ok) {
      setAnswer(result.body);
      setConfirming(false);
      toast.success(t('refreshed'));
      // Focus moves to the new link, so a keyboard user lands on what changed.
      setTimeout(() => fieldRef.current?.querySelector('input')?.focus(), 0);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const mapped = problemOf(result.failure);
    setRefreshProblem(
      mapped.kind === 'throttled'
        ? t('error.throttled', { minutes: mapped.minutes })
        : t('error.refresh'),
    );
  }

  if (denied) {
    return <EmptyState size="page" icon="lock" title={t('denied.title')} body={t('denied.body')} />;
  }
  if (problem !== null) {
    return (
      <LoadError
        className="w-full"
        message={
          problem.kind === 'throttled'
            ? t('error.throttled', { minutes: problem.minutes })
            : t('error.load')
        }
        retryLabel={tl('retry')}
        onRetry={() => void load()}
      />
    );
  }
  if (answer === null) {
    return (
      <div className="flex items-center gap-2 text-fg-muted" role="status">
        <Spinner />
        {t('loading')}
      </div>
    );
  }
  const { link, signups } = answer;
  const url =
    link === null || storefrontOrigin === null ? null : inviteUrl(storefrontOrigin, link.token);
  const total = signups.active + signups.rejected;

  async function copyLink() {
    if (url === null) return;
    try {
      await navigator.clipboard.writeText(url);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copy-failed'));
    }
  }
  async function saveQr() {
    if (url === null) return;
    if (!(await downloadQrPng(url, 'invite-qr.png'))) toast.error(t('qr-failed'));
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-fg-muted">{t('intro')}</p>
      <Card title={t('link.title')}>
        {link === null ? (
          <EmptyState
            size="compact"
            icon="link"
            title={t('none.title')}
            body={t('none.body')}
            action={
              <Button disabled={working} onClick={() => void refresh()}>
                {working ? <Spinner /> : null}
                {t('none.create')}
              </Button>
            }
          />
        ) : url === null ? (
          <Banner tone="attention">{t('no-origin')}</Banner>
        ) : (
          <>
            <div ref={fieldRef} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="min-w-0 flex-1">
                <TextField label={t('link.label')} value={url} readOnly dir="ltr" />
              </div>
              <Button variant="secondary" className="max-sm:w-full" onClick={() => void copyLink()}>
                {t('link.copy')}
              </Button>
            </div>
            <div className="flex flex-col items-center gap-3 sm:items-start">
              <InviteQr text={url} label={t('qr.alt')} />
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void saveQr()}>
                  {t('qr.download')}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setRefreshProblem(null);
                    setConfirming(true);
                  }}
                >
                  {t('link.refresh')}
                </Button>
              </div>
            </div>
          </>
        )}
      </Card>
      <Card title={t('signups.title')}>
        <p>
          <span className="text-3xl font-semibold">{total}</span>{' '}
          <span className="text-fg-muted">{t('signups.label', { count: total })}</span>
        </p>
        {signups.rejected > 0 ? <p className="text-sm text-fg-muted">{t('signups.hint')}</p> : null}
      </Card>
      <Card title={t('how.title')}>
        <ul className="list-disc ps-5">
          <li>{t('how.one')}</li>
          <li>{t('how.two')}</li>
          <li>{t('how.three')}</li>
        </ul>
      </Card>
      <ConfirmAction
        open={confirming}
        level={2}
        title={t('confirm.title')}
        body={t('confirm.body')}
        rowName=""
        confirmLabel={t('confirm.confirm')}
        cancelLabel={t('confirm.cancel')}
        pending={working}
        error={refreshProblem}
        onConfirm={() => void refresh()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
