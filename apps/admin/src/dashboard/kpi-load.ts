import 'server-only';
import { redirect } from 'next/navigation';
import { serverGet } from '../server/server-fetch.ts';
import type { AdminSession } from '../server/session.ts';
import {
  KPI_MONEY_PERMISSION,
  KPI_ORDERS_PERMISSION,
  type AdminKpis,
  type AdminKpiSource,
  type KpiPeriod,
} from './kpi-types.ts';

/**
 * Starts the KPI read of the home page. Not asked for without one of the two keys; a refusal
 * after all hides the strip, any other failure is an in-place error. A rejected session sends the
 * page to sign-in. The page streams it, like every card of the dashboard.
 */
export function startAdminKpis(session: AdminSession, period: KpiPeriod): AdminKpiSource {
  const keys = new Set(session.permissionKeys);
  if (!keys.has(KPI_ORDERS_PERMISSION) && !keys.has(KPI_MONEY_PERMISSION)) return null;
  const answer = serverGet<AdminKpis>(`dashboard/admin/kpis?period=${period}`).then((result) => {
    if (result.kind === 'ok') return { kind: 'ok' as const, value: result.body };
    if (result.kind === 'signed-out') redirect('/session-ended');
    if (result.kind === 'forbidden') return null;
    return { kind: 'error' as const };
  });
  answer.catch(() => undefined);
  return answer;
}
