'use client';

import { ActionRow, Banner, Button, Card, Dialog } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { useCountdown } from '../api/use-countdown.ts';

const BY_CODE: Readonly<Record<string, string>> = {
  'second-factor.none': 'none',
  'seller.unknown': 'no-owner',
  'account.unknown': 'no-owner',
  'request.throttled': 'throttled',
  'request.csrf': 'csrf',
  'access.denied': 'denied',
  'conflict.stale': 'retry',
  'conflict.retry': 'retry',
};

/** The message key (under `sellers.owner-reset.error`) for a refused start. */
export function ownerResetProblemOf(failure: { status: number; code: string }): string {
  const named = BY_CODE[failure.code];
  if (named !== undefined) return named;
  if (failure.status === 429) return 'throttled';
  if (failure.status === 403) return 'denied';
  return failure.status === 503 || failure.status === 0 ? 'unavailable' : 'unknown';
}

/**
 * Starts the reset of the Seller Owner's two-step sign-in (identity slice 12, A11): the API mails
 * the owner a one-time link, and nothing is removed until the owner confirms it there. Starting
 * again replaces the earlier link.
 */
export function OwnerSecondFactorCard({
  sellerId,
  csrfToken,
}: {
  readonly sellerId: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('sellers.owner-reset');
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  // The receipt stays while the link is out; the button then offers to send another.
  const [sent, setSent] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [wait, setWait] = useCountdown();
  const busy = useRef(false);

  async function start() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setProblem(null);
    const result = await callApi<{ code: string; sellerId: string }>(
      'POST',
      `identity/admin/sellers/${sellerId}/second-factor/reset`,
      {},
      csrfToken,
    );
    busy.current = false;
    setPending(false);
    setConfirming(false);
    if (result.ok) {
      setSent(true);
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setSent(false);
    const key = ownerResetProblemOf(result.failure);
    setProblem(key);
    const seconds = result.failure.details?.retryAfterSeconds;
    if (key === 'throttled' && typeof seconds === 'number' && seconds > 0) {
      setWait(Math.ceil(seconds));
    }
  }

  return (
    <Card title={t('title')}>
      <p className="text-fg-secondary">{t('intro')}</p>
      {sent ? (
        <Banner tone="success" title={t('sent.title')}>
          {t('sent.body')}
        </Banner>
      ) : null}
      {problem === null ? null : problem === 'throttled' ? (
        <Banner tone="attention">
          {wait > 0 ? t('error.throttled-wait', { seconds: wait }) : t('error.throttled')}
        </Banner>
      ) : problem === 'none' ? (
        <Banner tone="info">{t('error.none')}</Banner>
      ) : (
        <Banner tone="critical">{t(`error.${problem}`)}</Banner>
      )}
      <ActionRow>
        <Button
          variant="secondary"
          disabled={wait > 0}
          onClick={() => {
            setProblem(null);
            setConfirming(true);
          }}
        >
          {t(sent ? 'action-again' : 'action')}
        </Button>
      </ActionRow>
      <Dialog
        open={confirming}
        title={t('confirm.title')}
        onClose={() => {
          if (!pending) setConfirming(false);
        }}
        actions={
          <>
            <Button variant="secondary" disabled={pending} onClick={() => setConfirming(false)}>
              {t('confirm.cancel')}
            </Button>
            <Button loading={pending} onClick={() => void start()}>
              {t('confirm.submit')}
            </Button>
          </>
        }
      >
        <p>{t('confirm.body')}</p>
      </Dialog>
    </Card>
  );
}
