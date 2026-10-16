import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SellerDashboard } from '../../src/dashboard/dashboard.tsx';
import { loadSellerDashboard } from '../../src/dashboard/load.ts';
import { SETUP_ROOT } from '../../src/setup/steps.ts';
import { requireSession } from '../../src/server/session.ts';
import { SellerShell } from '../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('home.title') };
}

export default async function HomePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  // Until the seller is approved the limited shell has one page: the account setup (ID-UX F5).
  if (gate.session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  const data = await loadSellerDashboard(gate.session);
  return (
    <SellerShell session={gate.session} activeId="s_home" title={t('home.title')}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="break-words text-2xl font-semibold">{t('home.title')}</h1>
          <p className="text-fg-muted">{t('home.intro', { name: gate.session.displayName })}</p>
        </div>
        <SellerDashboard data={data} permissionKeys={gate.session.permissionKeys} />
      </div>
    </SellerShell>
  );
}
