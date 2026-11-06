import { LoadError, SettingsPage } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { loadStockPage } from '../../../../src/server/stock-page.ts';
import { SettingsNoAccess } from '../../../../src/settings/settings-no-access.tsx';
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
    // Without a session the shell cannot be drawn: the plain error is all there is.
    if (page.session === undefined)
      return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
    // Only the data failed: keep the settings layout (sub-navigation, breadcrumb, page title).
    return (
      <SettingsShell session={page.session} linkId="stock-locations" title={t('stock.title')}>
        <SettingsPage title={t('stock.title')}>
          <LoadError
            title={t('settings.load-error.title', { page: t('stock.title') })}
            message={t('settings.load-error.body')}
            retryLabel={t('load.retry')}
            className="w-full"
          />
        </SettingsPage>
      </SettingsShell>
    );
  }
  if (page.kind === 'no-access') {
    return (
      <SettingsShell session={page.session} linkId="stock-locations" title={t('stock.title')}>
        <SettingsNoAccess
          pageTitle={t('stock.title')}
          permissionKeys={page.session.permissionKeys}
          title={t('stock.no-access.title')}
          body={t('stock.no-access.body')}
          labels={{ settings: t('settings.sub.back'), home: t('settings.back-home') }}
        />
      </SettingsShell>
    );
  }
  return (
    <SettingsShell session={page.session} linkId="stock-locations" title={t('stock.title')}>
      <StockLocations
        initial={page.view}
        options={page.options}
        csrfToken={page.session.csrfToken}
        canEdit={page.session.permissionKeys.includes(SOURCE_EDIT_PERMISSION)}
      />
    </SettingsShell>
  );
}
