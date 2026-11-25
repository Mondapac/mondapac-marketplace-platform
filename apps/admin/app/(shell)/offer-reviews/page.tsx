import { LoadError, PageHeader } from '@mondapac/ui';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { localZone } from '../../../src/shared/format.ts';
import { OfferReviewQueue } from '../../../src/offer-review/queue.tsx';
import { DECIDE_PERMISSION, VIEW_PERMISSION, parseTab } from '../../../src/offer-review/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('offer-review.queue.title') };
}

type SearchParams = Readonly<Record<string, string | readonly string[] | undefined>>;

/**
 * The Offer review queue (risk-based Offer approval slice 5, ADR-0051): Offers waiting for their
 * first publication and held edits of live Offers, each a super list read by the browser through
 * the panel's own routes, with the decision drawer.
 */
export default async function OfferReviewsPage({
  searchParams,
}: {
  readonly searchParams: Promise<SearchParams>;
}) {
  const tab = parseTab(await searchParams);
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('offer-review.queue.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="offer-reviews" title={title}>
      <PageHeader title={title} className="mb-4" />
      {body}
    </AdminShell>
  );
  const { permissionKeys, csrfToken } = gate.session;
  if (!permissionKeys.includes(VIEW_PERMISSION)) {
    return shell(
      <>
        <p className="text-fg-muted">
          {t('offer-review.queue.no-access', { permission: VIEW_PERMISSION })}
        </p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('catalog.review.back-home')}
          </a>
        </p>
      </>,
    );
  }
  // List paging (settings): page numbers only when the Market says so; unreadable means Previous and next.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return shell(
    <OfferReviewQueue
      tab={tab}
      paging={paging}
      accountId={gate.session.accountId}
      marketId={marketId}
      csrfToken={csrfToken}
      zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
      permissionKeys={permissionKeys}
      canDecide={permissionKeys.includes(DECIDE_PERMISSION)}
    />,
  );
}
