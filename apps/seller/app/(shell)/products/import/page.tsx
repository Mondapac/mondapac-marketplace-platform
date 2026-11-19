import { EmptyState, LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { canRunImport } from '../../../../src/catalog/import/import-types.ts';
import { SellerImport } from '../../../../src/catalog/import/seller-import.tsx';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';
import { SETUP_ROOT } from '../../../../src/setup/steps.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.import.title') };
}

/**
 * The Import page of Catalogue > Products (catalog design 14c). It needs both the import key and
 * the product edit key; the API checks the same keys on every call, and the page only spares a
 * member without them a screen that could not work.
 */
export default async function ImportPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('catalog.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  const title = t('catalog.import.title');
  return (
    <SellerShell session={session} activeId="s_import" title={title}>
      {canRunImport(session.permissionKeys) ? (
        <SellerImport csrfToken={session.csrfToken} />
      ) : (
        <EmptyState
          size="page"
          icon="lock"
          title={t('catalog.no-access.title')}
          body={t('catalog.import.no-access')}
        />
      )}
    </SellerShell>
  );
}
