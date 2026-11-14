import { Banner, LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { typeNames } from '../../../../src/certificates/format.ts';
import { CertificatesTabs } from '../../../../src/certificates/tabs.tsx';
import { RequestsTable } from '../../../../src/certificates/requests/requests-table.tsx';
import {
  API_REQUESTS,
  PAGE_SIZE,
  REQUESTS_VIEW_PERMISSION,
  type RequestPage,
} from '../../../../src/certificates/requests/types.ts';
import { TYPE_VIEW_PERMISSION, type TypesList } from '../../../../src/certificates/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.requests.title') };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Certificates > Issuer requests (certificate issuers design A12): the open requests of sellers whose
 * issuer is not in the registry, oldest first, in keyset pages. Needs the issuer view permission.
 */
export default async function IssuerRequestsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly after?: string | readonly string[];
    readonly answered?: string | readonly string[];
  }>;
}) {
  const { after, answered } = await searchParams;
  const cursor = typeof after === 'string' && UUID.test(after) ? after : null;
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
  const message = (key: 'no-access' | 'unavailable') => (
    <>
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('certificates.requests.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t('certificates.requests.no-access')}</p>
      )}
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('certificates.queue.back-home')}
        </a>
      </p>
    </>
  );
  if (!keys.includes(REQUESTS_VIEW_PERMISSION)) return shell(message('no-access'));

  const query = new URLSearchParams({ limit: String(PAGE_SIZE) });
  if (cursor !== null) query.set('afterId', cursor);
  const [result, types] = await Promise.all([
    serverGet<RequestPage>(`${API_REQUESTS}?${query.toString()}`),
    keys.includes(TYPE_VIEW_PERMISSION)
      ? serverGet<TypesList>('certification/admin/types')
      : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return shell(message('no-access'));
  if (result.kind !== 'ok') return shell(message('unavailable'));
  const locale = await getLocale();
  const names = typeNames(types?.kind === 'ok' ? types.body.items : [], locale);
  const next = result.body.nextAfterId;

  return shell(
    <div className="flex flex-col gap-4">
      <CertificatesTabs active="requests" permissionKeys={keys} />
      {answered === '1' ? (
        <Banner tone="success">{t('certificates.requests.answered')}</Banner>
      ) : null}
      <p className="text-sm text-fg-muted">
        {t('certificates.requests.total', { count: result.body.total })}
      </p>
      <RequestsTable rows={result.body.items} typeNames={names} morePages={next !== null} />
      <div className="flex gap-4">
        {cursor === null ? null : (
          <a className="font-medium text-link underline" href="/certificates/issuer-requests">
            {t('certificates.queue.first-page')}
          </a>
        )}
        {next === null ? null : (
          <a
            className="font-medium text-link underline"
            href={`/certificates/issuer-requests?after=${encodeURIComponent(next)}`}
          >
            {t('certificates.queue.more')}
          </a>
        )}
      </div>
    </div>,
  );
}
