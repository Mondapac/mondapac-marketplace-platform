import { LoadError, NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { loadStockPage } from '../../../../src/server/stock-page.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { StockLocations } from '../../../../src/stock/stock-locations.tsx';
import { SOURCE_EDIT_PERMISSION } from '../../../../src/stock/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('stock.title') };
}

export default async function StockLocationsPage() {
  const t = await getTranslations();
  const page = await loadStockPage();
  if (page.kind === 'unavailable') {
    return <LoadError message={t('stock.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  if (page.kind === 'no-access') {
    return (
      <SettingsShell session={page.session} linkId="stock-locations" title={t('stock.title')}>
        <NoAccess
          title={t('stock.no-access.title')}
          body={t('stock.no-access.body')}
          backHref="/settings"
          backLabel={t('settings.sub.back')}
        />
      </SettingsShell>
    );
  }
  return (
    <SettingsShell session={page.session} linkId="stock-locations" title={t('stock.title')}>
      <h1 className="mb-6 text-2xl font-semibold">{t('stock.title')}</h1>
      <StockLocations
        initial={page.view}
        options={page.options}
        csrfToken={page.session.csrfToken}
        canEdit={page.session.permissionKeys.includes(SOURCE_EDIT_PERMISSION)}
      />
    </SettingsShell>
  );
}
