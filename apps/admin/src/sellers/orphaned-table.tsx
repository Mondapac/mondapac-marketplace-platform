import { Badge, Menu, type BadgeTone } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortInstant } from '../shared/format.ts';
import { known } from './format.ts';
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
  const locale = useLocale();
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
            <th scope="col" className="px-3 py-3 text-end font-medium">
              {t('col.actions')}
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line-row">
          {rows.map((row) => {
            const state = known(row.state, ORPHAN_STATES);
            const invite = row.actions.invite;
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
                  <time dateTime={row.createdAt}>{shortInstant(row.createdAt, locale)}</time>
                </td>
                <td className="px-3 py-3 text-end">
                  <Menu
                    label={t('actions-for', { id: shortSellerId(row.sellerId) })}
                    items={[
                      {
                        id: 'invite',
                        label: t('invite.action'),
                        disabled: !invite.allowed,
                        ...(invite.allowed
                          ? {}
                          : { reason: t(`invite.unavailable.${helpKey(invite.code)}`) }),
                        onSelect: () => onInvite(row),
                      },
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
