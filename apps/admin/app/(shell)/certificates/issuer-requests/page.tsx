import { Banner, LoadError, NoAccess } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { toId } from '../../../../src/sales/search-route.ts';
import { localZone } from '../../../../src/shared/format.ts';
import { typeNames } from '../../../../src/certificates/format.ts';
import { CertificatesTabs } from '../../../../src/certificates/tabs.tsx';
import { RequestsList } from '../../../../src/certificates/requests/requests-list.tsx';
import { REQUESTS_VIEW_PERMISSION } from '../../../../src/certificates/requests/types.ts';
import { TYPE_VIEW_PERMISSION, type TypesList } from '../../../../src/certificates/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.requests.title') };
}

/**
 * Certificates > Issuer requests (certificate issuers design A12): the open requests of sellers
 * whose issuer is not in the registry, as a super list that the client loads (search, filters,
 * sort and paging are its own queries). The page reads the Market's List paging setting, and the
 * type names for a reader who may view the types. Needs the issuer view permission.
 */
export default async function IssuerRequestsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly answered?: string | readonly string[];
    readonly sellerId?: string | readonly string[];
  }>;
}) {
  const { answered, sellerId } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('certificates.title');
  const keys = gate.session.permissionKeys;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="certificates" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {body}
    </AdminShell>
  );
  if (!keys.includes(REQUESTS_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('certificates.requests.no-access')}
        body={t('certificates.requests.no-access-body')}
        backHref="/"
        backLabel={t('certificates.requests.back-home')}
      />,
    );
  }

  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of requests.
  const [mode, types] = await Promise.all([
    serverGet<{ readonly listPaging: string }>('settings/admin/list-paging'),
    keys.includes(TYPE_VIEW_PERMISSION)
      ? serverGet<TypesList>('certification/admin/types')
      : Promise.resolve(null),
  ]);
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const locale = await getLocale();
  const names = typeNames(types?.kind === 'ok' ? types.body.items : [], locale);
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  // A link from a seller page may name one seller; anything that is not an id is ignored.
  const seller = typeof sellerId === 'string' ? toId(sellerId) : null;

  return shell(
    <div className="flex flex-col gap-4">
      <CertificatesTabs active="requests" permissionKeys={keys} />
      {answered === '1' ? (
        <Banner tone="success">{t('certificates.requests.answered')}</Banner>
      ) : null}
      <RequestsList
        paging={paging}
        accountId={gate.session.accountId}
        marketId={marketId}
        csrfToken={gate.session.csrfToken}
        zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        typeNames={Object.fromEntries(names)}
        sellerId={seller}
      />
    </div>,
  );
}
