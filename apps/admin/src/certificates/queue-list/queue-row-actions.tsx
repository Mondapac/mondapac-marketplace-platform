'use client';

import type { MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { ROW_ACTIONS, type QueueListRow } from './queue-types.ts';

/**
 * The Actions menu of a queue row: exactly the actions the row's `actions` array names (the server
 * decides per caller), in a fixed order; an id this panel does not know is ignored. Open goes to
 * the review page; Decide... goes to its decision section (the decision itself is made there, and
 * the API checks it again).
 */
export function useQueueRowActions(): (row: QueueListRow) => readonly MenuItem[] {
  const t = useTranslations('certificates.queue.actions');
  const router = useRouter();
  return (row) =>
    ROW_ACTIONS.filter((action) => row.actions.includes(action)).map(
      (action): MenuItem => ({
        id: action,
        label: t(action),
        onSelect: () =>
          router.push(
            `/certificates/${encodeURIComponent(row.certificateId)}${
              action === 'decide' ? '#rv-decision' : ''
            }`,
          ),
      }),
    );
}
