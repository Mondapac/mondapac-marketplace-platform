'use client';

import {
  BackLink,
  Badge,
  Banner,
  Button,
  Card,
  Menu,
  SkeletonRows,
  type MenuItem,
} from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { CustomersList } from './customers-list.tsx';
import { GroupArchiveDialog, GroupDialog } from './group-dialog.tsx';
import { GROUPS_MANAGE, type CustomerGroup } from './groups-types.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'not-found' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly group: CustomerGroup };

/**
 * One manual customer group (customers management phase 2a): its name, description and member
 * count with Rename… and Archive… (or Restore…), then its members as the Customers super list
 * scoped to the group (same tabs, filters, columns, export; the Bulk menu removes from this
 * group). An archived group says so: its members stay, it takes no new ones.
 */
export function GroupPage({
  groupId,
  accountId,
  marketId,
  marketName,
  zone,
  paging,
  permissionKeys,
  csrfToken,
}: {
  readonly groupId: string;
  readonly accountId: string;
  readonly marketId: string;
  readonly marketName: string;
  readonly zone: string;
  readonly paging: 'pages' | 'prev-next';
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('customers.groups');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [editing, setEditing] = useState(false);
  const [archiving, setArchiving] = useState<CustomerGroup | null>(null);
  const canManage = permissionKeys.includes(GROUPS_MANAGE);

  const read = useCallback(
    async (quiet = false) => {
      if (!quiet) setLoad({ state: 'loading' });
      const result = await callApi<CustomerGroup>(
        'GET',
        `customers/admin/groups/${encodeURIComponent(groupId)}`,
      );
      if (result.ok) {
        setLoad({ state: 'ready', group: result.body });
        return;
      }
      if (result.failure.status === 401) {
        window.location.assign('/session-ended');
        return;
      }
      // A quiet refresh (the member count after a change) keeps the page as it is.
      if (quiet) return;
      setLoad({
        state:
          result.failure.code === 'customers.group-not-found' || result.failure.status === 404
            ? 'not-found'
            : 'failed',
      });
    },
    [groupId],
  );

  useEffect(() => {
    void read();
  }, [read]);

  const back = <BackLink href="/customers/groups" label={t('back')} />;
  if (load.state === 'loading') {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <SkeletonRows label={t('loading')} rows={4} />
      </div>
    );
  }
  if (load.state === 'not-found') {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Banner tone="info" title={t('not-found.title')}>
          {t('not-found.body')}
        </Banner>
      </div>
    );
  }
  if (load.state === 'failed') {
    return (
      <div className="flex flex-col gap-4">
        {back}
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('failed-one')}</span>
            <Button variant="secondary" onClick={() => void read()}>
              {t('retry')}
            </Button>
          </div>
        </Banner>
      </div>
    );
  }

  const { group } = load;
  const more: MenuItem[] = group.archived
    ? [{ id: 'restore', label: t('row.restore'), onSelect: () => setArchiving(group) }]
    : [
        {
          id: 'archive',
          label: t('row.archive'),
          tone: 'critical',
          onSelect: () => setArchiving(group),
        },
      ];
  const saved = (next: CustomerGroup) => setLoad({ state: 'ready', group: next });

  return (
    <div className="flex flex-col gap-4">
      {back}
      <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <h1 className="text-2xl font-semibold wrap-anywhere">{group.name}</h1>
            {group.description === null ? null : (
              <p className="text-fg-muted wrap-anywhere">{group.description}</p>
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-fg-secondary">
                {t('members-count', { count: group.memberCount })}
              </span>
              {group.archived ? <Badge tone="neutral">{t('archived-badge')}</Badge> : null}
            </div>
          </div>
          {canManage ? (
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              <Button variant="secondary" onClick={() => setEditing(true)}>
                {t('row.rename')}
              </Button>
              <Menu label={t('more')} icon="more-horizontal" items={more} />
            </div>
          ) : null}
        </div>
        {group.archived ? (
          <div className="mt-3">
            <Banner tone="info">{t('archived-banner')}</Banner>
          </div>
        ) : null}
      </Card>
      <h2 className="sr-only">{t('members-heading')}</h2>
      <CustomersList
        key={group.groupId}
        accountId={accountId}
        marketId={marketId}
        marketName={marketName}
        zone={zone}
        paging={paging}
        permissionKeys={permissionKeys}
        csrfToken={csrfToken}
        group={group}
        onMembersChanged={() => void read(true)}
      />
      <GroupDialog
        open={editing}
        group={group}
        csrfToken={csrfToken}
        onClose={() => setEditing(false)}
        onSaved={saved}
      />
      <GroupArchiveDialog
        group={archiving}
        csrfToken={csrfToken}
        onClose={() => setArchiving(null)}
        onSaved={saved}
      />
    </div>
  );
}
