'use client';

import { Badge, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { Risk, SystemRequest } from './types.ts';
import { daysOverdue, humanKind, isApproval, kindKey } from './types.ts';

const RISK_TONE: Readonly<Record<Risk, BadgeTone>> = {
  low: 'neutral',
  medium: 'attention',
  high: 'critical',
};

/** The area, as a neutral badge. */
export function AreaBadge({ area }: { readonly area: string }) {
  const t = useTranslations('system-requests');
  return <Badge tone="neutral">{t.has(`area.${area}`) ? t(`area.${area}`) : area}</Badge>;
}

/** The risk: colour and always its word. */
export function RiskBadge({ risk }: { readonly risk: Risk }) {
  const t = useTranslations('system-requests');
  return <Badge tone={RISK_TONE[risk] ?? 'neutral'}>{t(`risk.${risk}`)}</Badge>;
}

/**
 * The status (Open, Approved, Reverted with its decision), an "Overdue" badge on an open request
 * past its date and a "Superseded" badge on one a later request changed again.
 */
export function StatusBadges({ request }: { readonly request: SystemRequest }) {
  const t = useTranslations('system-requests');
  const approval = isApproval(request);
  const tone: BadgeTone =
    request.status === 'open' ? 'info' : request.status === 'approved' ? 'success' : 'neutral';
  // An action that waits for approval was never applied, so a declined one is not "Reverted".
  const declined = approval && request.status === 'reverted';
  const label = declined
    ? t(
        request.decision === 'withdrawn'
          ? 'decision.approval-withdrawn'
          : 'decision.approval-rejected',
      )
    : t(`status.${request.status}`);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Badge tone={tone}>{label}</Badge>
      {approval && request.status === 'open' ? (
        <Badge tone="attention">{t('waits-for-approval')}</Badge>
      ) : null}
      {!approval &&
      request.status === 'reverted' &&
      request.decision !== null &&
      request.decision !== 'approved' ? (
        <span className="text-xs text-fg-muted">{t(`decision.${request.decision}`)}</span>
      ) : null}
      {request.status === 'open' && request.overdue ? (
        <Badge tone="critical">{t('overdue')}</Badge>
      ) : null}
      {request.status === 'open' && request.supersededBy !== null ? (
        <Badge tone="neutral">{t('superseded')}</Badge>
      ) : null}
    </span>
  );
}

/** "3 days overdue" in danger text; nothing when the request is not late. */
export function OverdueText({
  request,
  zone,
}: {
  readonly request: SystemRequest;
  readonly zone: string;
}) {
  const t = useTranslations('system-requests');
  if (request.status !== 'open' || !request.overdue) return null;
  const days = Math.max(1, daysOverdue(request.reviewDueAt, new Date(), zone));
  return <span className="font-medium text-critical-fg">{t('overdue-days', { count: days })}</span>;
}

/** The title of a subject kind ("Commission rate"); a kind the catalogue lacks is humanised. */
export function useKindTitle(): (kind: string) => string {
  const t = useTranslations('system-requests.kind');
  return (kind) => (t.has(kindKey(kind)) ? t(kindKey(kind)) : humanKind(kind));
}

/** Who did it: "You" for the admin themself, else the name the API sent, else "Admin". */
export function usePersonName(
  accountId: string,
): (id: string | null, name?: string | null) => string {
  const t = useTranslations('system-requests');
  return (id, name) => {
    if (id !== null && id === accountId) return t('you');
    return name !== undefined && name !== null && name.trim() !== '' ? name : t('admin');
  };
}
