import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { DisputesList } from '../../../src/disputes/disputes-list.tsx';
import { VIEW_PERMISSION } from '../../../src/disputes/types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';
import { displayZone } from '../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('disputes.title') };
}

export default async function DisputesPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  const title = t('disputes.title');
  if (gate.kind === 'unavailable') {
    // No session, so no shell; the page still has its heading.
    return (
      <div className="flex flex-col gap-4 p-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      </div>
    );
  }
  return (
    <AdminShell session={gate.session} activeId="disputes" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {gate.session.permissionKeys.includes(VIEW_PERMISSION) ? (
        <DisputesList zone={displayZone(gate.session.timezone)} />
      ) : (
        <>
          <p className="text-fg-muted">{t('disputes.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('disputes.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
