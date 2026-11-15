import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AlertsList } from '../../../../src/security-centre/alerts-list.tsx';
import { SecurityFrame, SecurityNoAccess } from '../../../../src/security-centre/frame.tsx';
import {
  SEVERITIES,
  STATE_FILTERS,
  VIEW_PERMISSION,
  type Severity,
  type StateFilter,
} from '../../../../src/security-centre/types.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('security-centre.title') };
}

/**
 * Security > Alerts (design v3, screens 1-2): the live alerts first, read again every 30 s while
 * the tab is visible (F4). The list reads in the browser so a refresh keeps filters and focus.
 */
export default async function SecurityAlertsPage({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly state?: string | readonly string[];
    readonly severity?: string | readonly string[];
  }>;
}) {
  const { state, severity } = (await searchParams) ?? {};
  // Only known values pass; anything else is the default view.
  const initialState = STATE_FILTERS.find((value) => value === state) ?? 'live';
  const initialSeverities =
    typeof severity === 'string'
      ? SEVERITIES.filter((value) => severity.split(',').includes(value))
      : [];
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  if (!session.permissionKeys.includes(VIEW_PERMISSION)) {
    return (
      <SecurityFrame session={session} tab={null}>
        <SecurityNoAccess />
      </SecurityFrame>
    );
  }
  return (
    <SecurityFrame session={session} tab="alerts">
      <AlertsList
        zone={localZone(session.timezone, session.marketTimezone)}
        initialState={initialState satisfies StateFilter}
        initialSeverities={initialSeverities satisfies readonly Severity[]}
      />
    </SecurityFrame>
  );
}
