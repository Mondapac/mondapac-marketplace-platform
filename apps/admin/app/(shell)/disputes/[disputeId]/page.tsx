import { BackLink, LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { DisputeDetailView } from '../../../../src/disputes/dispute-detail.tsx';
import {
  ATTRIBUTE_PERMISSION,
  VIEW_PERMISSION,
  type DisputeDetail,
} from '../../../../src/disputes/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { displayZone } from '../../../../src/shared/format.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('disputes.detail.page-title') };
}

export default async function DisputePage({
  params,
}: {
  readonly params: Promise<{ readonly disputeId: string }>;
}) {
  const { disputeId } = await params;
  if (!UUID.test(disputeId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    // No session, so no shell; the page still has its heading.
    return (
      <div className="flex flex-col gap-4 p-4">
        <h1 className="text-2xl font-semibold">{t('disputes.detail.page-title')}</h1>
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      </div>
    );
  }
  const { session } = gate;
  const title = t('disputes.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={session} activeId="disputes" title={title}>
      {body}
    </AdminShell>
  );
  const message = (key: 'no-access' | 'not-found') =>
    shell(
      <div className="flex flex-col gap-4">
        <BackLink href="/disputes" label={title} />
        <h1 className="text-2xl font-semibold">{t(`disputes.${key}-title`)}</h1>
        <p className="text-fg-muted">{t(`disputes.${key}`)}</p>
      </div>,
    );
  if (!session.permissionKeys.includes(VIEW_PERMISSION)) return message('no-access');
  const result = await serverGet<DisputeDetail>(`commission-payouts/admin/disputes/${disputeId}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return message('no-access');
  if (result.kind === 'not-found') return message('not-found');
  if (result.kind !== 'ok') {
    return shell(
      <div className="flex flex-col gap-4">
        <BackLink href="/disputes" label={title} />
        <h1 className="text-2xl font-semibold">{t('disputes.detail.page-title')}</h1>
        <LoadError message={t('disputes.error.unavailable')} retryLabel={t('load.retry')} />
      </div>,
    );
  }
  return shell(
    <DisputeDetailView
      initial={result.body}
      zone={displayZone(session.timezone)}
      canDecide={session.permissionKeys.includes(ATTRIBUTE_PERMISSION)}
      accountId={session.accountId}
      csrfToken={session.csrfToken}
    />,
  );
}
