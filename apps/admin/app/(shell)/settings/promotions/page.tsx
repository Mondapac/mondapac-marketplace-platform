import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { PromotionsSettingsPanel } from '../../../../src/promotions-settings/promotions-settings-panel.tsx';
import {
  PROMOTIONS_MANAGE,
  PROMOTIONS_SETTINGS_MANAGE,
  PROMOTIONS_SETTINGS_VIEW,
  SWITCH_PATH,
  type MarketSwitch,
} from '../../../../src/promotions-settings/types.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('promotionsSettings.title') };
}

export default async function PromotionsSettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('promotionsSettings.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="promotions" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(PROMOTIONS_SETTINGS_VIEW)) {
    return shell(
      <NoAccess
        pageTitle={title}
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('promotionsSettings.permission-view'),
        })}
        backHref="/settings"
        backLabel={t('settings.sub.back')}
      />,
    );
  }
  const read = await serverGet<MarketSwitch>(SWITCH_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('settings.load-error.body')}
          retryLabel={t('load.retry')}
          className="w-full"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <PromotionsSettingsPanel
      initial={read.body}
      canManageSwitch={permissionKeys.includes(PROMOTIONS_SETTINGS_MANAGE)}
      canManagePromotions={permissionKeys.includes(PROMOTIONS_MANAGE)}
      csrfToken={csrfToken}
    />,
  );
}
