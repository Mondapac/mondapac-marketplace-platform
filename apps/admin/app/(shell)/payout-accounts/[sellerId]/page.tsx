import { LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AccountDetail } from '../../../../src/payments/account-detail.tsx';
import { VIEW_PERMISSION, type ConnectedAccountDetail } from '../../../../src/payments/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payments.accounts.detail.page-title') };
}

export default async function PayoutAccountPage({
  params,
}: {
  readonly params: Promise<{ readonly sellerId: string }>;
}) {
  const { sellerId } = await params;
  if (!UUID.test(sellerId)) notFound();
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('payments.accounts.title');
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="payout-accounts" title={title}>
      {body}
    </AdminShell>
  );
  const message = (key: 'no-access' | 'not-found') =>
    shell(
      <>
        <h1 className="mb-2 text-2xl font-semibold">{t(`payments.accounts.${key}-title`)}</h1>
        <p className="text-fg-muted">{t(`payments.accounts.${key}`)}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/payout-accounts">
            {t('payments.accounts.detail.back')}
          </a>
        </p>
      </>,
    );
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) return message('no-access');
  const result = await serverGet<ConnectedAccountDetail>(
    `payments/admin/connected-accounts/${sellerId}`,
  );
  if (result.kind === 'signed-out') redirect('/session-ended');
  if (result.kind === 'ok') return shell(<AccountDetail account={result.body} />);
  if (result.kind === 'forbidden') return message('no-access');
  if (result.kind === 'not-found') return message('not-found');
  return shell(
    <LoadError message={t('payments.accounts.error.unavailable')} retryLabel={t('load.retry')} />,
  );
}
