import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { toId } from '../../../src/sales/search-route.ts';
import { RefundsList } from '../../../src/sales/refunds/refunds-list.tsx';
import { VIEW_PERMISSION } from '../../../src/sales/refunds/refunds-types.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { requireSession } from '../../../src/server/session.ts';
import { localZone } from '../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('refunds.page-title') };
}

export default async function RefundsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly sellerId?: string | readonly string[] }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('refunds.title');
  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of refunds.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  // A link from a seller page may name one seller; anything that is not a UUID v7 is ignored; the API wants it lower-case.
  const { sellerId } = await searchParams;
  const seller = typeof sellerId === 'string' ? toId(sellerId) : null;
  return (
    <AdminShell session={gate.session} activeId="refunds" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {gate.session.permissionKeys.includes(VIEW_PERMISSION) ? (
        <RefundsList
          paging={paging}
          accountId={gate.session.accountId}
          marketId={marketId}
          csrfToken={gate.session.csrfToken}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
          sellerId={seller}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('refunds.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('refunds.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
