import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { CustomerLookup } from '../../../src/customers/customer-lookup.tsx';
import { DISABLE_PERMISSION, VIEW_PERMISSION } from '../../../src/customers/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('customers.title') };
}

export default async function CustomersPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('customers.title');
  const keys = new Set(gate.session.permissionKeys);
  return (
    <AdminShell session={gate.session} activeId="customers" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {keys.has(VIEW_PERMISSION) ? (
        // The status action shows only to an actor who holds its key; the server checks again.
        <CustomerLookup
          canChangeStatus={keys.has(DISABLE_PERMISSION)}
          walletLink={
            keys.has('wallet.credit.issue')
              ? 'issue'
              : keys.has('wallet.credit.view')
                ? 'view'
                : null
          }
          csrfToken={gate.session.csrfToken}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('customers.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('customers.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
