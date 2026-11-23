import { LoadError, PageHeader } from '@mondapac/ui';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { localZone } from '../../../src/shared/format.ts';
import { requireSession } from '../../../src/server/session.ts';
import { HoldsList } from '../../../src/pricing/holds-list.tsx';
import { VIEW_PERMISSION } from '../../../src/pricing/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('pricing.holds.title') };
}

export default async function PriceHoldsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('pricing.holds.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="price-holds" title={title}>
      <PageHeader title={title} className="mb-4" />
      {body}
    </AdminShell>
  );
  const message = (key: string) => (
    <>
      {key === 'unavailable' ? (
        <LoadError
          className="flex flex-col items-start gap-3"
          message={t('pricing.holds.unavailable')}
          retryLabel={t('load.retry')}
        />
      ) : (
        <p className="text-fg-muted">{t(`pricing.holds.${key}`)}</p>
      )}
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('pricing.holds.back-home')}
        </a>
      </p>
    </>
  );
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return shell(message('no-access'));
  }
  // List paging (settings): page numbers only when the Market says so; unreadable means Previous and next.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return shell(
    <HoldsList
      paging={paging}
      accountId={gate.session.accountId}
      marketId={marketId}
      csrfToken={gate.session.csrfToken}
      zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
    />,
  );
}
