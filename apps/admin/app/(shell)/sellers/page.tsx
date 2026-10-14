import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';
import { SellersList } from '../../../src/sellers/sellers-list.tsx';
import { REVIEW_PERMISSION } from '../../../src/sellers/review-types.ts';
import { ORPHANED_VIEW_PERMISSION } from '../../../src/sellers/orphaned-types.ts';
import { LIST_PERMISSION } from '../../../src/sellers/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('sellers.list.title') };
}

export default async function SellersPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('sellers.list.title');
  const allowed = gate.session.permissionKeys.includes(LIST_PERMISSION);
  return (
    <AdminShell session={gate.session} activeId="sellers" title={title}>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h1 className="text-2xl font-semibold">{title}</h1>
        {gate.session.permissionKeys.includes(ORPHANED_VIEW_PERMISSION) ? (
          <a
            className="inline-flex min-h-12 items-center font-medium text-link underline"
            href="/sellers/without-owner"
          >
            {t('sellers.orphaned.link')}
          </a>
        ) : null}
      </div>
      {allowed ? (
        <SellersList
          csrfToken={gate.session.csrfToken}
          canReview={gate.session.permissionKeys.includes(REVIEW_PERMISSION)}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('sellers.list.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('sellers.list.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
