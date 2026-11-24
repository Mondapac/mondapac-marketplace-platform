import { LoadError, PageHeader } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SellerDashboard } from '../../src/dashboard/dashboard.tsx';
import { startSellerDashboard } from '../../src/dashboard/load.ts';
import { KpiSection } from '../../src/dashboard/kpis/kpi-section.tsx';
import { startSellerKpis } from '../../src/dashboard/kpis/load.ts';
import { DEFAULT_PERIOD, isPeriod } from '../../src/dashboard/kpis/types.ts';
import { SETUP_ROOT } from '../../src/setup/steps.ts';
import { requireSession } from '../../src/server/session.ts';
import { SellerShell } from '../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('home.title') };
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ readonly period?: string | string[] }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  // Until the seller is approved the limited shell has one page: the account setup (ID-UX F5).
  if (gate.session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  // Not awaited: each card streams in with its own read (panel loading L4).
  const data = startSellerDashboard(gate.session);
  const asked = (await searchParams).period;
  const period = isPeriod(asked) ? asked : DEFAULT_PERIOD;
  const kpiSources = startSellerKpis(gate.session, period);
  return (
    <SellerShell session={gate.session} activeId="s_home" title={t('home.title')}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <PageHeader title={t('home.title')} />
        </div>
        <SellerDashboard
          data={data}
          permissionKeys={gate.session.permissionKeys}
          {...(kpiSources === null
            ? {}
            : { kpis: <KpiSection sources={kpiSources} period={period} /> })}
        />
      </div>
    </SellerShell>
  );
}
