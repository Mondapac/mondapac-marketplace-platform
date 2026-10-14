import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';
import { OrphanedList } from '../../../../src/sellers/orphaned-list.tsx';
import { ORPHANED_VIEW_PERMISSION } from '../../../../src/sellers/orphaned-types.ts';
import { NoticeProvider } from '../../../../src/team/notice.tsx';

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
          <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
          <NoticeProvider>
            <OrphanedList csrfToken={gate.session.csrfToken} />
          </NoticeProvider>
        </>
      ) : (
        <div className="flex flex-col items-start gap-3 rounded-lg border border-line p-6">
          <h1 className="text-xl font-semibold">{t('sellers.orphaned.no-access.title')}</h1>
          <p className="text-fg-muted">{t('sellers.orphaned.no-access.body')}</p>
          <a className="inline-flex min-h-12 items-center font-medium text-link underline" href="/">
            {t('sellers.orphaned.no-access.action')}
          </a>
        </div>
      )}
    </AdminShell>
  );
}
