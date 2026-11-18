import { EmptyState, LinkButton, LoadError, NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { RequestDetail } from '../../../../src/system-requests/request-detail.tsx';
import { QUEUE_PATH, VIEW_PERMISSION } from '../../../../src/system-requests/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('system-requests.title') };
}

export default async function SystemRequestPage({
  params,
}: {
  readonly params: Promise<{ readonly requestId: string }>;
}) {
  const { requestId } = await params;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('system-requests.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="system-requests" title={title}>
      {body}
    </AdminShell>
  );
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('system-requests.no-access')}
        body={t('system-requests.no-access-body')}
        backHref="/"
        backLabel={t('system-requests.back-home')}
      />,
    );
  }
  if (!UUID.test(requestId)) {
    return shell(
      <EmptyState
        size="card"
        icon="search"
        title={t('system-requests.detail.not-found')}
        action={
          <LinkButton variant="secondary" href={QUEUE_PATH}>
            {title}
          </LinkButton>
        }
      />,
    );
  }
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return shell(
    <RequestDetail
      requestId={requestId}
      accountId={gate.session.accountId}
      csrfToken={gate.session.csrfToken}
      zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
      marketId={marketId}
    />,
  );
}
