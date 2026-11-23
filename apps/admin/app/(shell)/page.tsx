import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminDashboard } from '../../src/dashboard/dashboard.tsx';
import { startAdminKpis } from '../../src/dashboard/kpi-load.ts';
import { AdminKpiStrip } from '../../src/dashboard/kpis.tsx';
import { DEFAULT_KPI_PERIOD, isKpiPeriod } from '../../src/dashboard/kpi-types.ts';
import { startAdminDashboard } from '../../src/dashboard/load.ts';
import { AdminShell } from '../../src/server/admin-shell.tsx';
import { requireSession } from '../../src/server/session.ts';
import { localZone } from '../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('home.title') };
}

export default async function HomePage({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  // Not awaited: each card streams in with its own read (panel loading L4).
  const { period: asked } = await searchParams;
  const period = isKpiPeriod(asked) ? asked : DEFAULT_KPI_PERIOD;
  const kpis = startAdminKpis(gate.session, period);
  const data = startAdminDashboard(gate.session);
  return (
    <AdminShell session={gate.session} activeId="home" title={t('home.title')}>
      <div className="flex flex-col gap-6">
        <div className="flex flex-col gap-1">
          <h1 className="break-words text-2xl font-semibold">{t('home.title')}</h1>
          <p className="text-fg-muted">{t('home.intro', { name: gate.session.displayName })}</p>
        </div>
        <AdminKpiStrip source={kpis} period={period} permissionKeys={gate.session.permissionKeys} />
        <AdminDashboard
          data={data}
          permissionKeys={gate.session.permissionKeys}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        />
      </div>
    </AdminShell>
  );
}
