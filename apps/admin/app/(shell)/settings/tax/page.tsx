import { LoadError, NoAccess, SettingsPage } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { SettingsShell } from '../../../../src/server/settings-shell.tsx';
import { TaxPanel } from '../../../../src/tax/tax-panel.tsx';
import {
  TAX_MANAGE_PERMISSION,
  TAX_STRATEGIES_PATH,
  TAX_VIEW_PERMISSION,
  type TaxStrategyList,
} from '../../../../src/tax/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('tax.title') };
}

export default async function TaxSettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('tax.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <SettingsShell session={gate.session} linkId="tax" title={title}>
      {body}
    </SettingsShell>
  );
  if (!permissionKeys.includes(TAX_VIEW_PERMISSION)) {
    return shell(
      <NoAccess
        title={t('settings.no-access-title')}
        body={t('settings.no-access-needs', {
          page: title,
          permission: t('tax.permission-view'),
        })}
        backHref="/"
        backLabel={t('settings.back-home')}
      />,
    );
  }
  const read = await serverGet<TaxStrategyList>(TAX_STRATEGIES_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(
      <SettingsPage title={title}>
        <LoadError
          message={t('tax.unavailable')}
          retryLabel={t('load.retry')}
          className="flex flex-col items-start gap-3"
        />
      </SettingsPage>,
    );
  }
  return shell(
    <TaxPanel
      initial={read.body}
      canManage={permissionKeys.includes(TAX_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
