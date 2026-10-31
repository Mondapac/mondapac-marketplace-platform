import { BackLink, LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PayoutDetailView } from '../../../../src/payouts/payout-detail.tsx';
import {
  APPROVE_PERMISSION,
  VIEW_PERMISSION,
  type PayoutDetail,
} from '../../../../src/payouts/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { displayZone } from '../../../../src/shared/format.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payouts.detail.page-title') };
}

export default async function PayoutPage({
  params,
}: {
  readonly params: Promise<{ readonly payoutId: string }>;
}) {
  const { payoutId } = await params;
  if (!UUID.test(payoutId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    // No session, so no shell; the page still has its heading.
    return (
      <div className="flex flex-col gap-4 p-4">
        <h1 className="text-2xl font-semibold">{t('payouts.detail.page-title')}</h1>
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      </div>
    );
  }
  const { session } = gate;
  const title = t('payouts.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={session} activeId="payouts" title={title}>
      {body}
    </AdminShell>
  );
  const message = (key: 'no-access' | 'not-found') =>
    shell(
      <div className="flex flex-col gap-4">
        <BackLink href="/payouts" label={title} />
        <h1 className="text-2xl font-semibold">{t(`payouts.${key}-title`)}</h1>
        <p className="text-fg-muted">{t(`payouts.${key}`)}</p>
      </div>,
    );
  if (!session.permissionKeys.includes(VIEW_PERMISSION)) return message('no-access');
  const result = await serverGet<PayoutDetail>(`commission-payouts/admin/payouts/${payoutId}`);
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'forbidden') return message('no-access');
  if (result.kind === 'not-found') return message('not-found');
  if (result.kind !== 'ok') {
    return shell(
      <div className="flex flex-col gap-4">
        <BackLink href="/payouts" label={title} />
        <h1 className="text-2xl font-semibold">{t('payouts.detail.page-title')}</h1>
        <LoadError message={t('payouts.error.unavailable')} retryLabel={t('load.retry')} />
      </div>,
    );
  }
  return shell(
    <PayoutDetailView
      initial={result.body}
      zone={displayZone(session.timezone)}
      canApprove={session.permissionKeys.includes(APPROVE_PERMISSION)}
      accountId={session.accountId}
      csrfToken={session.csrfToken}
    />,
  );
}
