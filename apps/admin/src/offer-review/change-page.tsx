'use client';

import { useTranslations } from 'next-intl';
import { ReviewDetail } from './detail.tsx';
import { tabHref, type ChangeRow } from './types.ts';

/**
 * The deep link to one held edit (`/offer-reviews/:changeId`): the same content and decision as the
 * drawer, on a page of its own. Deciding sends the reviewer back to the Edits list.
 */
export function ChangePage({
  change,
  csrfToken,
  zone,
  canDecide,
  permissionKeys,
}: {
  readonly change: ChangeRow;
  readonly csrfToken: string;
  readonly zone: string;
  readonly canDecide: boolean;
  readonly permissionKeys: readonly string[];
}) {
  const t = useTranslations('offer-review.queue');
  return (
    <div className="flex max-w-4xl flex-col gap-4">
      <div>
        <a
          className="font-medium text-link underline focus-visible:outline-2 focus-visible:outline-focus"
          href={tabHref('edits')}
        >
          {t('back')}
        </a>
      </div>
      <ReviewDetail
        subject={{ kind: 'edit', row: change }}
        csrfToken={csrfToken}
        zone={zone}
        canDecide={canDecide}
        viewerKeys={permissionKeys}
        layout="page"
        onReload={() => window.location.reload()}
        onDecided={() => window.location.assign(tabHref('edits'))}
      />
    </div>
  );
}
