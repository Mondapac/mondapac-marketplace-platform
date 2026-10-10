import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';
import { SellersList } from '../../../src/sellers/sellers-list.tsx';
import { REVIEW_PERMISSION } from '../../../src/sellers/review-types.ts';
import { LIST_PERMISSION } from '../../../src/sellers/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('sellers.list.title') };
}

export default async function SellersPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('identity.error.unknown')}</p>;
  }
  const title = t('sellers.list.title');
  const allowed = gate.session.permissionKeys.includes(LIST_PERMISSION);
  return (
    <AdminShell session={gate.session} activeId="sellers" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
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
