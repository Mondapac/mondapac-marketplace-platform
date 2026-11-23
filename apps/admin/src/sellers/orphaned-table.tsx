import { Badge, CARD_TABLE, Menu, type BadgeTone } from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { shortInstantInZone } from '../shared/format.ts';
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
  zone,
}: {
  readonly rows: readonly OrphanRow[];
  /** The IANA zone of the Created times (ADR-0005). */
  readonly zone: string;
  readonly onInvite: (row: OrphanRow) => void;
}) {
  const t = useTranslations('sellers.orphaned');
  const locale = useLocale();
  return (
    <div className="relative overflow-x-auto rounded-lg border border-line bg-surface">
      <table className={CARD_TABLE.table}>
        <caption className="sr-only">{t('title')}</caption>
        <thead className={CARD_TABLE.head}>
          <tr>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.seller')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.access')}
            </th>
            <th scope="col" className="px-4 py-3 font-medium">
              {t('col.created')}
            </th>
            <th scope="col" className={CARD_TABLE.actionsHead}>
              {t('col.actions')}
            </th>
          </tr>
        </thead>
        <tbody className={CARD_TABLE.body}>
          {rows.map((row) => {
            const state = known(row.state, ORPHAN_STATES);
            const invite = row.actions.invite;
            return (
              <tr key={row.sellerId} className={CARD_TABLE.row}>
                <td className={`${CARD_TABLE.cell} font-medium text-fg`} title={row.sellerId}>
                  {shortSellerId(row.sellerId)}
                </td>
                <td className={CARD_TABLE.corner}>
                  <Badge tone={TONE[state] ?? 'neutral'}>{t(`state.${state}`)}</Badge>
                </td>
                <td className={CARD_TABLE.labelled} data-label={t('col.created')}>
                  <time dateTime={row.createdAt}>
                    {shortInstantInZone(row.createdAt, locale, zone, true)}
                  </time>
                </td>
                <td className={CARD_TABLE.actions}>
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
