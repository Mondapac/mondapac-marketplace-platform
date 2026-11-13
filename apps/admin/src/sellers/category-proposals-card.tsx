'use client';

import { Banner, Button, Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRef, useState } from 'react';
import { callApi } from '../api/client.ts';

export const categoryProposalsPath = (sellerId: string): string =>
  `sellers/admin/${sellerId}/category-proposals`;

type Outcome =
  | { readonly kind: 'done'; readonly allowed: boolean; readonly changed: boolean }
  | { readonly kind: 'failed'; readonly key: string };

/**
 * "May propose categories" (sellers SEL-26, categories C9b) on the admin seller page. Off by
 * default; turning it off closes the seller's waiting proposals (shown as "Closed: permission
 * removed" in the queue). The API does not yet tell this page the current setting, so the card
 * offers both actions and reports what the last one did.
 */
export function CategoryProposalsCard({
  sellerId,
  csrfToken,
  canSeeQueue,
}: {
  readonly sellerId: string;
  readonly csrfToken: string;
  /** The admin may open the proposals tab (`catalog.category-proposal.decide`). */
  readonly canSeeQueue: boolean;
}) {
  const t = useTranslations('sellers.category-proposals');
  const [pending, setPending] = useState<boolean | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const busy = useRef(false);

  async function set(allowed: boolean) {
    if (busy.current) return;
    busy.current = true;
    setPending(allowed);
    setOutcome(null);
    const result = await callApi<{ allowed: boolean; changed: boolean }>(
      'PUT',
      categoryProposalsPath(sellerId),
      { allowed },
      csrfToken,
    );
    busy.current = false;
    setPending(null);
    if (result.ok) {
      setOutcome({ kind: 'done', allowed: result.body.allowed, changed: result.body.changed });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    const known: Record<string, string> = {
      'access.denied': 'denied',
      'request.csrf': 'csrf',
      'validation.failed': 'invalid',
    };
    setOutcome({ kind: 'failed', key: known[result.failure.code] ?? 'unknown' });
  }

  return (
    <Card title={t('title')}>
      <div className="flex flex-col gap-3">
        <p className="max-w-prose text-fg-muted">{t('intro')}</p>
        <div role="status">
          {outcome?.kind === 'done' ? (
            <p className="m-0 font-medium">
              {outcome.allowed ? t('now-allowed') : t('now-stopped')}
              {outcome.changed ? '' : ` ${t('no-change')}`}
            </p>
          ) : null}
        </div>
        {outcome?.kind === 'failed' ? (
          <div role="alert">
            <Banner tone="critical">{t(`error.${outcome.key}`)}</Banner>
          </div>
        ) : null}
        <div className="flex flex-wrap gap-3">
          <Button
            loading={pending === true}
            disabled={pending !== null}
            onClick={() => void set(true)}
          >
            {t('allow')}
          </Button>
          <Button
            variant="secondary"
            loading={pending === false}
            disabled={pending !== null}
            onClick={() => void set(false)}
          >
            {t('stop')}
          </Button>
        </div>
        {canSeeQueue ? (
          <p className="m-0 text-sm">
            <a
              className="font-medium text-link underline"
              href={`/catalog/categories?tab=proposals&seller=${sellerId}`}
            >
              {t('view-shelves')}
            </a>
          </p>
        ) : null}
      </div>
    </Card>
  );
}
