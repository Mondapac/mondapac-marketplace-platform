import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { localZone } from '../../../src/shared/format.ts';
import { SellersList } from '../../../src/sellers/sellers-list.tsx';
import { ORPHANED_VIEW_PERMISSION } from '../../../src/sellers/orphaned-types.ts';
import { SELLER_VIEW_PERMISSION } from '../../../src/sellers/health-types.ts';
import { LIST_PERMISSION } from '../../../src/sellers/types.ts';

/** The Inbox item Seller requests opens this page on the review tab (menu design v2). */
const REQUESTS_TAB = 'awaiting-review';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('sellers.list.title') };
}

export default async function SellersPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly tab?: string | readonly string[] }>;
}) {
  const { tab } = await searchParams;
  const requests = tab === REQUESTS_TAB;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('sellers.list.title');
  const allowed = gate.session.permissionKeys.includes(LIST_PERMISSION);
  // List paging (settings): page numbers only when the Market says so; a value that cannot be
  // read means Previous and next.
  let paging: 'pages' | 'prev-next' = 'prev-next';
  let marketId = '';
  if (allowed) {
    const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
    paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
    marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  }
  return (
    <AdminShell
      session={gate.session}
      activeId={requests ? 'seller-requests' : 'sellers'}
      title={title}
    >
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {gate.session.permissionKeys.includes(SELLER_VIEW_PERMISSION) ? (
          <a
            className="inline-flex min-h-12 items-center font-medium text-link underline"
            href="/sellers/needs-a-look"
          >
            {t('sellers.health-queue.link')}
          </a>
        ) : null}
        {gate.session.permissionKeys.includes(ORPHANED_VIEW_PERMISSION) ? (
          <a
            className="inline-flex min-h-12 items-center font-medium text-link underline"
            href="/sellers/without-owner"
          >
            {t('sellers.orphaned.link')}
          </a>
        ) : null}
      </div>
      {allowed ? (
        <SellersList
          key={requests ? 'requests' : 'all'}
          initialTab={requests ? REQUESTS_TAB : 'all'}
          csrfToken={gate.session.csrfToken}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
          paging={paging}
          accountId={gate.session.accountId}
          marketId={marketId}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('sellers.list.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('sellers.list.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
