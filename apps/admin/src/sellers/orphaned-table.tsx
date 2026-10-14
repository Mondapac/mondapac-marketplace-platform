import { Badge, Button, type BadgeTone } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { known, shortInstant } from './format.ts';
import { ORPHAN_STATES, shortSellerId, type OrphanRow } from './orphaned-types.ts';

const TONE: Record<string, BadgeTone> = {
  pending: 'attention',
  approved: 'success',
  rejected: 'critical',
  suspended: 'critical',
  unknown: 'neutral',
};

/** Why an invitation cannot be sent for this row, by the hint's code. */
function helpKey(code: string | null): string {
  if (code === 'access.denied') return 'denied';
  if (code === 'access.unavailable') return 'unavailable';
  return 'other';
}

/** Sellers without an owner: id, access state, created, and "Invite owner". */
export function OrphanedTable({
  rows,
  onInvite,
}: {
  readonly rows: readonly OrphanRow[];
  readonly onInvite: (row: OrphanRow) => void;
}) {
  const t = useTranslations('sellers.orphaned');
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line">
      <table className="w-full min-w-120 text-start text-sm">
        <caption className="sr-only">{t('title')}</caption>
        <thead className="bg-muted text-fg-muted">
          <tr>
            <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
              {t('col.seller')}
            </th>
            <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
              {t('col.access')}
            </th>
            <th scope="col" className="whitespace-nowrap px-3 py-3 font-medium">
              {t('col.created')}
            </th>
            <th scope="col" className="px-3 py-3 font-medium">
              <span className="sr-only">{t('col.actions')}</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {rows.map((row) => {
            const state = known(row.state, ORPHAN_STATES);
            const invite = row.actions.invite;
            const helpId = `orphan-help-${row.sellerId}`;
            return (
              <tr key={row.sellerId}>
                <td
                  className="whitespace-nowrap px-3 py-3 font-medium text-fg"
                  title={row.sellerId}
                >
                  {shortSellerId(row.sellerId)}
                </td>
                <td className="whitespace-nowrap px-3 py-3">
                  <Badge tone={TONE[state] ?? 'neutral'}>{t(`state.${state}`)}</Badge>
                </td>
                <td className="px-3 py-3">
                  <time dateTime={row.createdAt}>{shortInstant(row.createdAt)}</time>
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-col items-start gap-1">
                    <Button
                      variant="secondary"
                      className="min-h-12 whitespace-nowrap"
                      disabled={!invite.allowed}
                      aria-describedby={invite.allowed ? undefined : helpId}
                      aria-label={
                        invite.allowed
                          ? t('invite.row-label', { id: shortSellerId(row.sellerId) })
                          : undefined
                      }
                      onClick={() => onInvite(row)}
                    >
                      {t('invite.action')}
                    </Button>
                    {invite.allowed ? null : (
                      <p id={helpId} className="max-w-56 text-fg-muted">
                        {t(`invite.unavailable.${helpKey(invite.code)}`)}
                      </p>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
