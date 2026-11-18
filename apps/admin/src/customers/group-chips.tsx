'use client';

import { Icon } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import type { GroupRef } from './groups-types.ts';

const CHIP =
  'inline-flex min-w-0 max-w-full items-center rounded-full border border-line bg-muted text-sm text-fg';
const LINK =
  'min-w-0 truncate px-2.5 py-0.5 hover:underline focus-visible:outline-2 focus-visible:outline-focus';
/** The remove button keeps a 44 px hit area around its small icon (Reza, 16 Nov). */
const REMOVE =
  'relative -me-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-fg-secondary hover:bg-surface hover:text-fg focus-visible:outline-2 focus-visible:outline-focus before:absolute before:-inset-2.5 before:content-[""]';

/**
 * The manual groups a customer is in (phase 2a), as chips that open the group's page. A list row
 * shows the first two and "+N"; the Overview shows ten and the rest behind "Show all". An
 * archived group says so in its chip. With `onRemove`, each chip has a remove button named for
 * its group.
 */
export function GroupChips({
  groups,
  shown,
  onRemove,
  onShowAll,
}: {
  readonly groups: readonly GroupRef[];
  /** How many chips to show before "+N". */
  readonly shown: number;
  readonly onRemove?: (group: GroupRef) => void;
  /** Turns "+N" into a button that shows the rest. */
  readonly onShowAll?: () => void;
}) {
  const t = useTranslations('customers.groups');
  const visible = groups.slice(0, shown);
  const more = groups.length - visible.length;
  return (
    <ul className="flex min-w-0 flex-wrap items-center gap-1.5" aria-label={t('chips-label')}>
      {visible.map((group) => (
        <li key={group.groupId} className={CHIP}>
          <a href={`/customers/groups/${encodeURIComponent(group.groupId)}`} className={LINK}>
            {group.archived ? t('archived-name', { name: group.name }) : group.name}
          </a>
          {onRemove === undefined ? null : (
            <button
              type="button"
              className={REMOVE}
              aria-label={t('remove-from', { name: group.name })}
              onClick={() => onRemove(group)}
            >
              <Icon name="x" />
            </button>
          )}
        </li>
      ))}
      {more <= 0 ? null : onShowAll === undefined ? (
        <li className="text-sm text-fg-muted" aria-label={t('more-label', { count: more })}>
          {t('more-chips', { count: more })}
        </li>
      ) : (
        <li>
          <button
            type="button"
            className="text-sm font-medium text-link hover:underline focus-visible:outline-2 focus-visible:outline-focus"
            onClick={onShowAll}
          >
            {t('show-all', { count: groups.length })}
          </button>
        </li>
      )}
    </ul>
  );
}
