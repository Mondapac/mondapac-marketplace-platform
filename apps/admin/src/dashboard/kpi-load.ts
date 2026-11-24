import 'server-only';
import { redirect } from 'next/navigation';
import { serverGet } from '../server/server-fetch.ts';
import type { AdminSession } from '../server/session.ts';
import {
  allowedOf,
  wantsKpis,
  type AdminKpis,
  type AdminKpiSource,
  type KpiPeriod,
} from './kpi-types.ts';

/**
 * Starts the KPI read of the home page. Not asked for without a key of any KPI section; a refusal
 * after all hides the strip, any other failure is an in-place error. A rejected session sends the
 * page to sign-in. The page streams it, like every card of the dashboard.
 */
export function startAdminKpis(session: AdminSession, period: KpiPeriod): AdminKpiSource {
  if (!wantsKpis(allowedOf(session.permissionKeys))) return null;
  const answer = serverGet<AdminKpis>(`dashboard/admin/kpis?period=${period}`).then((result) => {
    if (result.kind === 'ok') return { kind: 'ok' as const, value: result.body };
    if (result.kind === 'signed-out') redirect('/session-ended');
    if (result.kind === 'forbidden') return null;
    return { kind: 'error' as const };
  });
  answer.catch(() => undefined);
  return answer;
}
