import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { ProductsList } from '../../../../src/catalog/products-list.tsx';
import { VIEW_PERMISSION } from '../../../../src/catalog/products-types.ts';
import { displayZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('catalog.products.title') };
}

export default async function ProductsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('catalog.products.title');
  const allowed = gate.session.permissionKeys.includes(VIEW_PERMISSION);
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return (
    <AdminShell session={gate.session} activeId="products" title={title}>
      {/* The topbar already names the page; the tabs come first, as in the design. */}
      <h1 className="sr-only">{title}</h1>
      {allowed ? (
        <ProductsList
          accountId={gate.session.accountId}
          marketId={marketId}
          timeZone={displayZone(gate.session.timezone)}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('catalog.products.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('catalog.products.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
