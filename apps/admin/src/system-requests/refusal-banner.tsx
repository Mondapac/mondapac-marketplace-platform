'use client';

import { Banner, Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { Refusal } from './errors.ts';
import { PROFILE_PATH, requestPath } from './types.ts';

/**
 * A refused decision at the top of the page: the cause in the spec's words, with the one next
 * step the cause allows (open the newer request, Try again, set up two-step verification, reload).
 */
export function RefusalBanner({
  refusal,
  reviewPermission,
  prefix,
  onRetry,
}: {
  readonly refusal: Refusal;
  /** The permission a reviewer of the request holds, for `not-reviewer`. */
  readonly reviewPermission?: string;
  /** The request number a list banner is about ("SR-1042"); a detail page leaves it out. */
  readonly prefix?: string;
  readonly onRetry?: () => void;
}) {
  const t = useTranslations('system-requests.refusal');
  return (
    <Banner tone={refusal.tone}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0">
          {prefix === undefined ? null : <span className="font-semibold">{prefix}. </span>}
          {t(refusal.key, { permission: reviewPermission ?? '' })}{' '}
          {refusal.newerRequestId === undefined ? null : (
            <a className="font-medium underline" href={requestPath(refusal.newerRequestId)}>
              {t('open-newer')}
            </a>
          )}
          {refusal.enrol === true ? (
            <a className="font-medium underline" href={PROFILE_PATH}>
              {t('open-profile')}
            </a>
          ) : null}
        </p>
        {refusal.retry === true && onRetry !== undefined ? (
          <Button variant="secondary" onClick={onRetry}>
            {t('retry')}
          </Button>
        ) : null}
        {refusal.reload === true ? (
          <Button variant="secondary" onClick={() => window.location.reload()}>
            {t('reload')}
          </Button>
        ) : null}
      </div>
    </Banner>
  );
}
