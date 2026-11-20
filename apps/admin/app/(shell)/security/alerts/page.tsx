import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { AlertsList } from '../../../../src/security-centre/alerts-list.tsx';
import { isView, type View } from '../../../../src/security-centre/alert-list/list-types.ts';
import { SecurityFrame, SecurityNoAccess } from '../../../../src/security-centre/frame.tsx';
import {
  SEVERITIES,
  VIEW_PERMISSION,
  type Severity,
} from '../../../../src/security-centre/types.ts';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('security-centre.title') };
}

const one = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/** The old links (`?state=`) still open the nearest view: the live alerts are the open ones. */
function viewOf(view: string | undefined, state: string | undefined): View | undefined {
  if (isView(view)) return view;
  if (state === 'live') return 'open';
  return isView(state) ? state : undefined;
}

/**
 * Security > Alerts (design v3, screens 1-2; super list 37): the live counts above the Market's
 * alerts as a super list, read again every 30 s while the tab is visible (F4). A link may open a
 * view (`?view=`, or the older `?state=`) and start on one severity (`?severity=`). The list reads
 * in the browser so a refresh keeps filters and focus.
 */
export default async function SecurityAlertsPage({
  searchParams,
}: {
  readonly searchParams?: Promise<{
    readonly view?: string | readonly string[];
    readonly state?: string | readonly string[];
    readonly severity?: string | readonly string[];
  }>;
}) {
  const params = (await searchParams) ?? {};
  // Only known values pass; anything else is the default view.
  const initialView = viewOf(one(params.view), one(params.state));
  const initialSeverity: Severity | undefined = SEVERITIES.find(
    (value) => value === one(params.severity),
  );
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
  // List paging (settings): page numbers only when the Market says so. A value that cannot be
  // read means Previous and next, which works for any number of alerts.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  return (
    <SecurityFrame session={session} tab="alerts">
      <AlertsList
        zone={localZone(session.timezone, session.marketTimezone)}
        paging={paging}
        accountId={session.accountId}
        marketId={marketId}
        csrfToken={session.csrfToken}
        {...(initialView === undefined ? {} : { initialView })}
        {...(initialSeverity === undefined ? {} : { initialSeverity })}
      />
    </SecurityFrame>
  );
}
