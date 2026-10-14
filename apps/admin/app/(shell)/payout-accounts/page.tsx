import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AccountsList } from '../../../src/payments/accounts-list.tsx';
import { VIEW_PERMISSION } from '../../../src/payments/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('payments.accounts.title') };
}

export default async function PayoutAccountsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('payments.accounts.title');
  return (
    <AdminShell session={gate.session} activeId="payout-accounts" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {gate.session.permissionKeys.includes(VIEW_PERMISSION) ? (
        <AccountsList />
      ) : (
        <>
          <p className="text-fg-muted">{t('payments.accounts.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('payments.accounts.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
