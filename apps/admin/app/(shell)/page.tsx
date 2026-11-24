import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminDashboard } from '../../src/dashboard/dashboard.tsx';
import { startAdminKpis } from '../../src/dashboard/kpi-load.ts';
import { marketToday, selectionOf } from '../../src/dashboard/kpi-range.ts';
import { DEFAULT_KPI_PERIOD } from '../../src/dashboard/kpi-types.ts';
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
  const selection = selectionOf(await searchParams, DEFAULT_KPI_PERIOD);
  // The Market's days (never the viewer's): a range may end today at the latest.
  const today = marketToday(gate.session.marketTimezone);
  const kpis = startAdminKpis(gate.session, selection, today);
  const data = startAdminDashboard(gate.session);
  return (
    <AdminShell session={gate.session} activeId="home" title={t('home.title')}>
      <AdminDashboard
        title={t('home.title')}
        data={data}
        permissionKeys={gate.session.permissionKeys}
        zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        kpis={kpis}
        selection={selection}
        today={today}
      />
    </AdminShell>
  );
}
