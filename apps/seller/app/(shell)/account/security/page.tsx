import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { TwoStepPanel } from '../../../../src/security/two-step-panel.tsx';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';
import { SettingsHeader } from '../../../../src/settings/settings-header.tsx';
import { requireSession } from '../../../../src/server/session.ts';
import { SETUP_ROOT } from '../../../../src/setup/steps.ts';

export async function generateMetadata() {
  const t = await getTranslations('security');
  return { title: t('page-title') };
}

export default async function SecurityPage() {
  const t = await getTranslations();
  const gate = await requireSession();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('security.error.unavailable')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  // Two-step verification is for an approved seller; the others finish their file first.
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  return (
    <SellerShell session={session} activeId="s_settings" title={t('settings.tab.security')}>
      <SettingsHeader active="security" permissionKeys={session.permissionKeys} t={t} />
      <TwoStepPanel active={session.secondFactorActive} csrfToken={session.csrfToken} />
    </SellerShell>
  );
}
