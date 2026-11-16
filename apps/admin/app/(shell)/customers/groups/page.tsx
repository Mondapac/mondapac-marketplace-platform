import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { CustomerGroups } from '../../../../src/customers/customer-groups.tsx';
import { VIEW_PERMISSION } from '../../../../src/customers/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('customers.groups.title') };
}

/** Customer groups (customers management phase 2a): the Market's manual groups. */
export default async function CustomerGroupsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('customers.groups.title');
  const keys = gate.session.permissionKeys;
  return (
    <AdminShell session={gate.session} activeId="customer-groups" title={title}>
      {keys.includes(VIEW_PERMISSION) ? (
        <CustomerGroups
          permissionKeys={keys}
          csrfToken={gate.session.csrfToken}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        />
      ) : (
        <>
          <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
          <p className="text-fg-muted">{t('customers.no-access')}</p>
        </>
      )}
    </AdminShell>
  );
}
