'use client';

import {
  Badge,
  Banner,
  Button,
  EmptyState,
  SkeletonRows,
  SuperTable,
  Tabs,
  type MenuItem,
  type SuperColumn,
  PageInfo,
} from '@mondapac/ui';
import { useLocale, useTranslations } from 'next-intl';
import { useCallback, useEffect, useState } from 'react';
import { callApi } from '../api/client.ts';
import { numberFormat } from '../shared/intl.ts';
import { dayOf } from './format.ts';
import { GroupArchiveDialog, GroupDialog } from './group-dialog.tsx';
import { GROUPS_MANAGE, type CustomerGroup, type CustomerGroupsAnswer } from './groups-types.ts';

type Load =
  | { readonly state: 'loading' }
  | { readonly state: 'failed' }
  | { readonly state: 'ready'; readonly items: readonly CustomerGroup[] };

type Shown = 'live' | 'archived';

/**
 * Customer groups (customers management phase 2a): the Market's manual groups, at most 500, live
 * or archived, newest first. A simple list (spec section 7): it becomes a super list if a Market
 * passes 50 groups. "New group…", and a row's Actions: Open, Rename…, Archive… or Restore…, for
 * an admin with `customers.groups.manage`. A group's members are the Customers list scoped to it.
 */
export function CustomerGroups({
  permissionKeys,
  csrfToken,
  zone,
}: {
  readonly permissionKeys: readonly string[];
  readonly csrfToken: string;
  readonly zone: string;
}) {
  const t = useTranslations('customers.groups');
  const locale = useLocale();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [shown, setShown] = useState<Shown>('live');
  const [editing, setEditing] = useState<CustomerGroup | 'new' | null>(null);
  const [archiving, setArchiving] = useState<CustomerGroup | null>(null);
  const canManage = permissionKeys.includes(GROUPS_MANAGE);

  const read = useCallback(async () => {
    setLoad({ state: 'loading' });
    const result = await callApi<CustomerGroupsAnswer>('GET', 'customers/admin/groups');
    if (result.ok) {
      setLoad({ state: 'ready', items: result.body.items });
      return;
    }
    if (result.failure.status === 401) {
      window.location.assign('/session-ended');
      return;
    }
    setLoad({ state: 'failed' });
  }, []);

  useEffect(() => {
    void read();
  }, [read]);

  const number = (value: number) => numberFormat(locale, {}).format(value);
  const items = load.state === 'ready' ? load.items : [];
  const live = items.filter((group) => !group.archived);
  const archived = items.filter((group) => group.archived);
  const rows = shown === 'live' ? live : archived;
  const open = (group: CustomerGroup) =>
    window.location.assign(`/customers/groups/${encodeURIComponent(group.groupId)}`);

  const columns: SuperColumn<CustomerGroup>[] = [
    {
      id: 'name',
      header: t('col.name'),
      primary: true,
      headClassName: 'min-w-48',
      cell: (group) => (
        <a
          href={`/customers/groups/${encodeURIComponent(group.groupId)}`}
          className="font-medium text-fg wrap-anywhere hover:underline focus-visible:outline-2 focus-visible:outline-focus"
        >
          {group.name}
        </a>
      ),
    },
    {
      id: 'members',
      header: t('col.members'),
      numeric: true,
      cell: (group) => number(group.memberCount),
    },
    {
      id: 'description',
      header: t('col.description'),
      cell: (group) =>
        group.description === null ? (
          <span className="text-fg-muted">—</span>
        ) : (
          <span className="wrap-anywhere">{group.description}</span>
        ),
    },
    {
      id: 'created',
      header: t('col.created'),
      cell: (group) => dayOf(group.createdAt, locale, zone),
    },
    ...(shown === 'archived'
      ? [
          {
            id: 'archived',
            header: t('col.archived'),
            corner: true,
            cell: (group: CustomerGroup) => (
              <Badge tone="neutral">
                {group.archivedAt === null
                  ? t('archived-badge')
                  : t('archived-on', { date: dayOf(group.archivedAt, locale, zone) })}
              </Badge>
            ),
          },
        ]
      : []),
  ];

  const rowItems = (group: CustomerGroup): MenuItem[] => [
    { id: 'open', label: t('row.open'), onSelect: () => open(group) },
    ...(canManage
      ? [
          { id: 'rename', label: t('row.rename'), onSelect: () => setEditing(group) },
          group.archived
            ? { id: 'restore', label: t('row.restore'), onSelect: () => setArchiving(group) }
            : {
                id: 'archive',
                label: t('row.archive'),
                tone: 'critical' as const,
                onSelect: () => setArchiving(group),
              },
        ]
      : []),
  ];

  const saved = (group: CustomerGroup) =>
    setLoad((current) =>
      current.state !== 'ready'
        ? current
        : {
            state: 'ready',
            items: current.items.some((item) => item.groupId === group.groupId)
              ? current.items.map((item) => (item.groupId === group.groupId ? group : item))
              : [group, ...current.items],
          },
    );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold">{t('title')}</h1>
            <PageInfo page={t('title')}>{t('intro')}</PageInfo>
          </div>
        </div>
        {canManage ? <Button onClick={() => setEditing('new')}>{t('new')}</Button> : null}
      </div>
      <Tabs
        label={t('views')}
        activeId={shown}
        onSelect={(id) => setShown(id as Shown)}
        items={[
          {
            id: 'live',
            label:
              load.state === 'ready'
                ? t('view.live-count', { count: live.length })
                : t('view.live'),
          },
          {
            id: 'archived',
            label:
              load.state === 'ready'
                ? t('view.archived-count', { count: archived.length })
                : t('view.archived'),
          },
        ]}
      />
      {load.state === 'loading' ? (
        <SkeletonRows label={t('loading')} rows={4} />
      ) : load.state === 'failed' ? (
        <Banner tone="critical">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t('failed')}</span>
            <Button variant="secondary" onClick={() => void read()}>
              {t('retry')}
            </Button>
          </div>
        </Banner>
      ) : (
        <div className="overflow-hidden rounded-lg border border-line bg-surface">
          <SuperTable
            caption={t('caption')}
            rows={rows}
            rowId={(group) => group.groupId}
            rowName={(group) => group.name}
            columns={columns}
            actions={{
              header: t('col.actions'),
              label: (name) => t('row.menu', { name }),
              items: rowItems,
            }}
            empty={
              <EmptyState
                size="compact"
                icon="users"
                title={shown === 'live' ? t('empty.live') : t('empty.archived')}
                body={shown === 'live' && canManage ? t('empty.live-help') : undefined}
              />
            }
          />
        </div>
      )}
      <GroupDialog
        open={editing !== null}
        group={editing === 'new' ? null : editing}
        csrfToken={csrfToken}
        onClose={() => setEditing(null)}
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
