'use client';

import { Banner } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';

/** What the API may say; anything else is read as "could not check". */
const TOLD = ['certificate-badge', 'handling', 'contact-text'] as const;
type Told = (typeof TOLD)[number];

type Preview =
  | { readonly kind: 'checking' }
  | { readonly kind: 'publish' }
  | { readonly kind: 'review'; readonly told: readonly Told[] }
  | { readonly kind: 'unavailable' };

/** The answer of `POST .../submit-preview`, checked: an unknown shape is "could not check". */
function previewOf(body: unknown): Preview {
  if (typeof body !== 'object' || body === null) return { kind: 'unavailable' };
  const { outcome, reasons } = body as { outcome?: unknown; reasons?: unknown };
  if (!Array.isArray(reasons)) return { kind: 'unavailable' };
  if (outcome === 'publish' && reasons.length === 0) return { kind: 'publish' };
  if (outcome !== 'review' || reasons.length === 0) return { kind: 'unavailable' };
  return {
    kind: 'review',
    told: TOLD.filter((reason) => reasons.includes(reason)),
  };
}

/**
 * The result bar before Submit (risk-based Offer approval slice 7b, design 9.5 a): asks the
 * server's dry run of the submit rules once, when a draft's page opens, and says whether the offer
 * goes on sale at once or waits for a check. The panel has no rules of its own: it shows only what
 * the server answered, and by name only what the seller can fix (a badge, handling, contact text);
 * every other reason is one "we check it first". A held price is the price row's own state, passed
 * in, never measured here. Not a promise, and a failure is "we couldn't check", never a guess.
 */
export function SubmitPreview({
  offerId,
  csrfToken,
  heldPrice = false,
}: {
  readonly offerId: string;
  readonly csrfToken: string;
  /** A price on this offer already waits for our check (pricing's own answer on the size rows). */
  readonly heldPrice?: boolean;
}) {
  const t = useTranslations('catalog.submit-preview');
  const [preview, setPreview] = useState<Preview>({ kind: 'checking' });

  useEffect(() => {
    let live = true;
    void callApi<unknown>(
      'POST',
      `catalog/seller/offers/${offerId}/submit-preview`,
      undefined,
      csrfToken,
    ).then(
      (result) => {
        if (!live) return;
        setPreview(result.ok ? previewOf(result.body) : { kind: 'unavailable' });
      },
      () => {
        if (live) setPreview({ kind: 'unavailable' });
      },
    );
    return () => {
      live = false;
    };
  }, [offerId, csrfToken]);

  const price = heldPrice ? <p>{t('price-held')}</p> : null;
  const promise = <p>{t('not-a-promise')}</p>;

  switch (preview.kind) {
    case 'checking':
      return (
        <p role="status" className="text-sm text-fg-muted">
          {t('checking')}
        </p>
      );
    case 'unavailable':
      return (
        <Banner tone="info">
          <div className="flex flex-col gap-1">
            <p>{t('unavailable')}</p>
            {price}
          </div>
        </Banner>
      );
    case 'publish':
      return (
        <Banner tone={heldPrice ? 'attention' : 'success'} title={t('publish.title')}>
          <div className="mt-1 flex flex-col gap-1">
            <p>{t('publish.body')}</p>
            {price}
            {promise}
          </div>
        </Banner>
      );
    case 'review':
      return (
        <Banner tone="attention" title={t('review.title')}>
          <div className="mt-1 flex flex-col gap-1">
            <p>{t('review.body')}</p>
            {preview.told.length > 0 ? (
              <ul className="list-disc ps-5">
                {preview.told.map((reason) => (
                  <li key={reason}>{t(`review.reason.${reason}`)}</li>
                ))}
              </ul>
            ) : null}
            {price}
            {promise}
          </div>
        </Banner>
      );
  }
}
