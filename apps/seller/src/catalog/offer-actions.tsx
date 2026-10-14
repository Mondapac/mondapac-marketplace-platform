'use client';

import { Banner, Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';
import { offerActionErrorOf } from './offer-action-errors.ts';

type Outcome = 'submitted' | 'published' | 'deleted';

/**
 * Submit and delete for one offer. Submit is for a draft; delete is for a draft or an offer that
 * needs changes. Delete asks for one more click. The API's refusal is shown in words
 * (for example `offer.handling-missing` until the seller can record handling).
 */
export function OfferActions({
  offerId,
  status,
  csrfToken,
}: {
  readonly offerId: string;
  readonly status: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('catalog.offer-actions');
  const tr = useTranslations();
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState<'submit' | 'delete' | null>(null);
  const busy = useRef(false);

  const canSubmit = status === 'draft';
  const canDelete = status === 'draft' || status === 'changes-needed';

  async function run(kind: 'submit' | 'delete') {
    if (busy.current) return;
    busy.current = true;
    setPending(kind);
    setError(null);
    const result =
      kind === 'submit'
        ? await callApi<{ published: boolean }>(
            'POST',
            `catalog/seller/offers/${offerId}/submit`,
            undefined,
            csrfToken,
          )
        : await callApi<null>('DELETE', `catalog/seller/offers/${offerId}`, undefined, csrfToken);
    busy.current = false;
    setPending(null);
    if (result.ok) {
      setConfirming(false);
      setOutcome(
        kind === 'delete'
          ? 'deleted'
          : (result.body as { published?: boolean } | null)?.published === true
            ? 'published'
            : 'submitted',
      );
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setConfirming(false);
    setError(offerActionErrorOf(result.failure));
  }

  if (outcome !== null) {
    return (
      <Banner tone="success">
        <span>{t(`done.${outcome}`)} </span>
        <a
          className="font-medium text-link underline"
          href={outcome === 'deleted' ? '/offers' : `/offers/${offerId}`}
        >
          {outcome === 'deleted' ? t('to-offers') : t('reload')}
        </a>
      </Banner>
    );
  }
  if (!canSubmit && !canDelete) return null;
  return (
    <div className="flex flex-col gap-3">
      {error === null ? null : <Banner tone="critical">{tr(error)}</Banner>}
      {confirming ? (
        <div className="flex flex-col gap-2">
          <p>{t('delete-confirm')}</p>
          <div className="flex flex-wrap gap-3">
            <Button
              variant="destructive"
              loading={pending === 'delete'}
              disabled={pending !== null}
              onClick={() => void run('delete')}
            >
              {t('delete-yes')}
            </Button>
            <Button
              variant="secondary"
              disabled={pending !== null}
              onClick={() => setConfirming(false)}
            >
              {t('cancel')}
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {canSubmit ? (
            <Button
              loading={pending === 'submit'}
              disabled={pending !== null}
              onClick={() => void run('submit')}
            >
              {t('submit')}
            </Button>
          ) : null}
          {canDelete ? (
            <Button
              variant="destructive"
              disabled={pending !== null}
              onClick={() => {
                setError(null);
                setConfirming(true);
              }}
            >
              {t('delete')}
            </Button>
          ) : null}
        </div>
      )}
    </div>
  );
}
