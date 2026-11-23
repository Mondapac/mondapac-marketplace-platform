import { LoadError, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';
import { OrphanedList } from '../../../../src/sellers/orphaned-list.tsx';
import { ORPHANED_VIEW_PERMISSION } from '../../../../src/sellers/orphaned-types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('sellers.orphaned.title') };
}

export default async function SellersWithoutOwnerPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('sellers.orphaned.title');
  const allowed = gate.session.permissionKeys.includes(ORPHANED_VIEW_PERMISSION);
  return (
    <AdminShell session={gate.session} activeId="sellers" title={title}>
      <a
        className="mb-1 inline-flex min-h-12 items-center font-medium text-link underline"
        href="/sellers"
      >
        {t('sellers.orphaned.back')}
      </a>
      {allowed ? (
        <>
          <PageHeader title={title} className="mb-4" />
          <OrphanedList csrfToken={gate.session.csrfToken} />
        </>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-line p-6">
          <PageHeader title={t('sellers.orphaned.no-access.title')} />
          <p className="text-fg-muted">{t('sellers.orphaned.no-access.body')}</p>
          <a className="inline-flex min-h-12 items-center font-medium text-link underline" href="/">
            {t('sellers.orphaned.no-access.action')}
          </a>
        </div>
      )}
    </AdminShell>
  );
}
