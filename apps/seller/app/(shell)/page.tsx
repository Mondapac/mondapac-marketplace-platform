import { LoadError, marketToday } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { SellerDashboard } from '../../src/dashboard/dashboard.tsx';
import { startSellerDashboard } from '../../src/dashboard/load.ts';
import { startSellerKpis } from '../../src/dashboard/kpis/load.ts';
import { rangeZoneOf, selectionOf } from '../../src/dashboard/kpis/range.ts';
import { DEFAULT_PERIOD } from '../../src/dashboard/kpis/types.ts';
import { SETUP_ROOT } from '../../src/setup/steps.ts';
import { readSellerZone } from '../../src/server/seller-zone.ts';
import { requireSession } from '../../src/server/session.ts';
import { SellerShell } from '../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('home.title') };
}

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{
    readonly period?: string | string[];
    readonly from?: string | string[];
    readonly to?: string | string[];
  }>;
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
  const selection = selectionOf(await searchParams, DEFAULT_PERIOD);
  // The Market's day now, the day the API judges a range on: a range may end today at the latest.
  // Without the Market zone in the session, the seller's working zone (UTC when it cannot be read).
  const zone = await readSellerZone();
  const today = marketToday(rangeZoneOf(gate.session.marketTimezone, zone));
  const kpiSources = startSellerKpis(gate.session, selection, today);
  return (
    <SellerShell session={gate.session} activeId="s_home" title={t('home.title')}>
      <div className="flex flex-col gap-6">
        <SellerDashboard
          title={t('home.title')}
          data={data}
          permissionKeys={gate.session.permissionKeys}
          kpis={kpiSources}
          selection={selection}
          today={today}
          zone={zone}
        />
      </div>
    </SellerShell>
  );
}
