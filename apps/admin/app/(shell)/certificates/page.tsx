import { Banner, LoadError } from '@mondapac/ui';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { requireSession } from '../../../src/server/session.ts';
import { localZone } from '../../../src/shared/format.ts';
import { toId } from '../../../src/sales/search-route.ts';
import { CertificatesTabs } from '../../../src/certificates/tabs.tsx';
import { QueueList } from '../../../src/certificates/queue-list/queue-list.tsx';
import { typeNames } from '../../../src/certificates/format.ts';
import {
  TYPE_VIEW_PERMISSION,
  VIEW_PERMISSION,
  type TypesList,
} from '../../../src/certificates/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('certificates.title') };
}

/**
 * Certificates (certificate screens design, A1): the seller certificates waiting for a decision as
 * a super list (views, search, filters, sort, columns, saved filters, export, paging). Type names
 * come from the types list when the reader may view types; otherwise the table shows the type
 * code.
 */
export default async function CertificatesPage({
  searchParams,
}: {
  readonly searchParams: Promise<{
    readonly decided?: string | readonly string[];
    readonly sellerId?: string | readonly string[];
  }>;
}) {
  const { decided, sellerId } = await searchParams;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('certificates.title');
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
          message={t('certificates.queue.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t('certificates.queue.no-access')}</p>
      )}
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('certificates.queue.back-home')}
        </a>
      </p>
    </>
  );
  const keys = gate.session.permissionKeys;
  // A reader who may only see the issuers lands on them: the menu item has one address.
  if (!keys.includes(VIEW_PERMISSION) && keys.includes('certification.issuer.view')) {
    redirect('/certificates/issuers');
  }
  if (!keys.includes(VIEW_PERMISSION)) return shell(message('no-access'));

  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of submissions.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  // The queue itself is read by the list in the browser, so a refused or failed read is the
  // list's own state. Type names only cost the names when the types list cannot be read.
  const types = keys.includes(TYPE_VIEW_PERMISSION)
    ? await serverGet<TypesList>('certification/admin/types')
    : null;
  if (types?.kind === 'signed-out') redirect('/session-ended');
  const locale = await getLocale();
  const names = typeNames(types?.kind === 'ok' ? types.body.items : [], locale);
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  // A link from a seller page may name one seller; anything that is not a UUID is ignored.
  const seller = typeof sellerId === 'string' ? toId(sellerId) : null;
  return shell(
    <div className="flex flex-col gap-4">
      <CertificatesTabs active="queue" permissionKeys={keys} />
      {decided === 'approve' || decided === 'request-changes' || decided === 'decline' ? (
        <Banner tone="success">{t(`certificates.review.decided.${decided}`)}</Banner>
      ) : null}
      <QueueList
        paging={paging}
        accountId={gate.session.accountId}
        marketId={marketId}
        csrfToken={gate.session.csrfToken}
        zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        types={[...names].map(([code, name]) => ({ code, name }))}
        sellerId={seller}
      />
    </div>,
  );
}
