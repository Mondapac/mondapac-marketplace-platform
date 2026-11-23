'use client';

import { LinkMenu, type LinkMenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { HEALTH_QUEUE_LIST_PATH, type HealthQueuePage } from './health-types.ts';
import type { OrphanPage } from './orphaned-types.ts';

/** The page the admin is on: its item is ticked, and "All sellers" is the way back. */
export type QueuesCurrent = 'all' | 'needs-a-look' | 'without-owner';

/** Rows asked of the owner-less list to count it (the list has no total): more reads "N+". */
const ORPHAN_COUNT_LIMIT = 100;

/** One queue's size, or null when it could not be read. `more` says the number is a floor. */
interface Count {
  readonly value: number;
  readonly more: boolean;
}

async function healthCount(): Promise<Count | null> {
  const result = await callApi<HealthQueuePage>(
    'GET',
    `${HEALTH_QUEUE_LIST_PATH}?${new URLSearchParams({ paging: 'prev-next', page: '1', pageSize: '1' }).toString()}`,
  );
  return result.ok ? { value: result.body.counts.all, more: result.body.truncated } : null;
}

async function orphanCount(): Promise<Count | null> {
  const result = await callApi<OrphanPage>(
    'GET',
    `identity/admin/sellers?${new URLSearchParams({ state: 'orphaned', limit: String(ORPHAN_COUNT_LIMIT) }).toString()}`,
  );
  return result.ok ? { value: result.body.items.length, more: result.body.next !== null } : null;
}

const show = (count: Count): string => `${count.value}${count.more ? '+' : ''}`;

/**
 * The Queues menu in the header of the Sellers pages: "Sellers that need a look" and "Sellers
 * without an owner", each only with its own permission (no permission at all: no button). The
 * neutral badge sums the queues the admin may see; it is hidden at 0 and when a count cannot be
 * read, never "0". The pages are real links.
 */
export function SellersQueuesMenu({
  current,
  canHealth,
  canOrphaned,
}: {
  readonly current: QueuesCurrent;
  readonly canHealth: boolean;
  readonly canOrphaned: boolean;
}) {
  const t = useTranslations('sellers.queues');
  const th = useTranslations('sellers.health-queue');
  const to = useTranslations('sellers.orphaned');
  const [health, setHealth] = useState<Count | null>(null);
  const [orphans, setOrphans] = useState<Count | null>(null);

  useEffect(() => {
    let live = true;
    if (canHealth) {
      void healthCount()
        .then((count) => live && setHealth(count))
        .catch(() => live && setHealth(null));
    }
    if (canOrphaned) {
      void orphanCount()
        .then((count) => live && setOrphans(count))
        .catch(() => live && setOrphans(null));
    }
    return () => {
      live = false;
    };
  }, [canHealth, canOrphaned]);

  if (!canHealth && !canOrphaned) return null;

  const items: LinkMenuItem[] = [
    ...(current === 'all' ? [] : [{ id: 'all', label: t('all'), href: '/sellers' }]),
    ...(canHealth
      ? [
          {
            id: 'needs-a-look',
            label: th('title'),
            href: '/sellers/needs-a-look',
            count: health === null ? null : health.value,
            current: current === 'needs-a-look',
          },
        ]
      : []),
    ...(canOrphaned
      ? [
          {
            id: 'without-owner',
            label: to('title'),
            href: '/sellers/without-owner',
            count: orphans === null ? null : orphans.value,
            current: current === 'without-owner',
          },
        ]
      : []),
  ];

  // A queue whose count could not be read adds nothing: the badge never claims a number it lacks.
  const counts = [canHealth ? health : null, canOrphaned ? orphans : null].filter(
    (count): count is Count => count !== null,
  );
  const unreadable = (canHealth && health === null) || (canOrphaned && orphans === null);
  const total = counts.reduce((sum, count) => sum + count.value, 0);
  const more = counts.some((count) => count.more);
  const badge =
    unreadable || total === 0
      ? null
      : {
          text: show({ value: total, more }),
          accessibleName: t('button-count', { count: total }),
        };

  return <LinkMenu label={t('button')} items={items} badge={badge} />;
}
