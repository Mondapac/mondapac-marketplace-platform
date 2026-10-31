import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import {
  BUYER_DELETE_PERMISSION,
  SETTINGS_PATH,
  SETTINGS_VIEW_PERMISSION,
  type AccountDeletionSettingsAnswer,
} from '../../../src/account-deletion/types.ts';
import { CustomerLookup } from '../../../src/customers/customer-lookup.tsx';
import { DISABLE_PERMISSION, VIEW_PERMISSION } from '../../../src/customers/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
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
  // The waiting period is shown in the delete dialog only to an admin who may read the setting;
  // a failed read shows no number (the dialog says "the waiting period" instead).
  let buyerDeletion: { readonly waitingPeriodDays: number | null } | null = null;
  if (keys.has(VIEW_PERMISSION) && keys.has(BUYER_DELETE_PERMISSION)) {
    const read = keys.has(SETTINGS_VIEW_PERMISSION)
      ? await serverGet<AccountDeletionSettingsAnswer>(SETTINGS_PATH)
      : null;
    if (read?.kind === 'signed-out') redirect('/session-ended');
    buyerDeletion = {
      waitingPeriodDays: read?.kind === 'ok' ? read.body.settings.waitingPeriodDays : null,
    };
  }
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
          buyerDeletion={buyerDeletion}
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
