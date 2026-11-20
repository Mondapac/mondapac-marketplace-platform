import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { HealthQueue } from '../../../../src/sellers/health-queue.tsx';
import { SELLER_VIEW_PERMISSION } from '../../../../src/sellers/health-types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('sellers.health-queue.title') };
}

export default async function SellersNeedingALookPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('sellers.health-queue.title');
  const back = (
    <a
      className="mb-1 inline-flex min-h-12 items-center font-medium text-link underline"
      href="/sellers"
    >
      {t('sellers.health-queue.back')}
    </a>
  );
  let body: React.ReactNode;
  if (!gate.session.permissionKeys.includes(SELLER_VIEW_PERMISSION)) {
    body = (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-line p-6">
        <h1 className="text-xl font-semibold">{t('sellers.health-queue.no-access.title')}</h1>
        <p className="text-fg-muted">{t('sellers.health-queue.no-access.body')}</p>
      </div>
    );
  } else {
    // List paging (settings): page numbers only when the Market says so; a value that cannot be
    // read means Previous and next.
    const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
    const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
    const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
    body = (
      <>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <HealthQueue paging={paging} accountId={gate.session.accountId} marketId={marketId} />
      </>
    );
  }
  return (
    <AdminShell session={gate.session} activeId="sellers" title={title}>
      {back}
      {body}
    </AdminShell>
  );
}
