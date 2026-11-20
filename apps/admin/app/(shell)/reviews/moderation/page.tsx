import { LoadError } from '@mondapac/ui';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { ModerationList } from '../../../../src/reviews/moderation-list/moderation-list.tsx';
import {
  MODERATE_PERMISSION,
  REMOVE_PERMISSION,
  VIEW_PERMISSION,
} from '../../../../src/reviews/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';
import { toId } from '../../../../src/sales/search-route.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('reviews-moderation.title') };
}

/**
 * Reviews (buyer review moderation, list 18): the held, reported and actioned reviews as a super
 * list (views, search, filters, sort, columns, saved filters, export, paging). A link may name one
 * seller (`?sellerId=`). Each review is moderated in its dialog, behind a fresh two-step code.
 */
export default async function ReviewModerationPage({
  searchParams,
}: {
  readonly searchParams?: Promise<{ readonly sellerId?: string | readonly string[] }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  const title = t('reviews-moderation.title');
  if (gate.kind === 'unavailable') {
    // No session, so no shell; the page still has its heading.
    return (
      <div className="flex flex-col gap-4 p-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      </div>
    );
  }
  const keys = gate.session.permissionKeys;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="review-moderation" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {body}
    </AdminShell>
  );
  if (!keys.includes(VIEW_PERMISSION)) {
    return shell(
      <>
        <p className="text-fg-muted">{t('reviews-moderation.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('reviews-moderation.back-home')}
          </a>
        </p>
      </>,
    );
  }
  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of reviews.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  // A link may name one seller; anything that is not an id is ignored.
  const sellerId = (await searchParams)?.sellerId;
  const seller = typeof sellerId === 'string' ? toId(sellerId) : null;
  return shell(
    <ModerationList
      paging={paging}
      accountId={gate.session.accountId}
      marketId={marketId}
      csrfToken={gate.session.csrfToken}
      zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
      canModerate={keys.includes(MODERATE_PERMISSION)}
      canRemove={keys.includes(REMOVE_PERMISSION)}
      sellerId={seller}
    />,
  );
}
