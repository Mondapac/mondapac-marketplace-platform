'use client';

import { Button, Card } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { callApi } from '../api/client.ts';
import { GroupChips } from './group-chips.tsx';
import { GroupMembersDialog, type MembersAction } from './group-members-dialog.tsx';
import {
  GROUP_CHIPS_SHOWN,
  GROUPS_MANAGE,
  type CustomerGroupsAnswer,
  type GroupRef,
} from './groups-types.ts';

/**
 * The customer's manual groups on the Overview (customers management phase 2a): chips that open
 * each group, ten at most with "Show all N" (Reza, 16 Nov). With `customers.groups.manage`,
 * "Add to group…" picks a live group and each chip's remove button takes the customer out after a
 * level 2 confirmation. Both are recorded on the customer's activity.
 */
export function CustomerGroupsCard({
  accountId,
  groups,
  keys,
  csrfToken,
  onChanged,
}: {
  readonly accountId: string;
  readonly groups: readonly GroupRef[];
  readonly keys: ReadonlySet<string>;
  readonly csrfToken: string;
  readonly onChanged: () => void;
}) {
  const t = useTranslations('customers.groups');
  const [all, setAll] = useState(false);
  const [action, setAction] = useState<MembersAction | null>(null);
  const [removing, setRemoving] = useState<GroupRef | null>(null);
  const [choices, setChoices] = useState<readonly GroupRef[] | null>(null);
  const [choicesFailed, setChoicesFailed] = useState(false);
  const canManage = keys.has(GROUPS_MANAGE);

  async function readChoices() {
    setChoices(null);
    setChoicesFailed(false);
    const result = await callApi<CustomerGroupsAnswer>('GET', 'customers/admin/groups');
    if (!result.ok) {
      setChoicesFailed(true);
      return;
    }
    // Groups the customer is already in are not offered again.
    setChoices(
      result.body.items.filter((group) => !groups.some((in_) => in_.groupId === group.groupId)),
    );
  }

  async function openAdd() {
    setRemoving(null);
    setAction('add');
    await readChoices();
  }

  return (
    <Card>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-semibold">{t('card-title')}</h2>
        {canManage ? (
          <Button variant="secondary" onClick={() => void openAdd()}>
            {t('add-to')}
          </Button>
        ) : null}
      </div>
      {groups.length === 0 ? (
        <p className="text-fg-muted">{t('card-empty')}</p>
      ) : (
        <GroupChips
          groups={groups}
          shown={all ? groups.length : GROUP_CHIPS_SHOWN}
          onShowAll={() => setAll(true)}
          {...(canManage
            ? {
                onRemove: (group: GroupRef) => {
                  setRemoving(group);
                  setAction('remove');
                },
              }
            : {})}
        />
      )}
      <GroupMembersDialog
        action={action}
        count={1}
        groups={action === 'add' ? choices : null}
        groupsFailed={action === 'add' && choicesFailed}
        onRetryGroups={() => void readChoices()}
        fixedGroup={action === 'remove' ? removing : null}
        target={{ ids: [accountId] }}
        csrfToken={csrfToken}
        onClose={() => {
          setAction(null);
          setRemoving(null);
          setChoices(null);
          setChoicesFailed(false);
        }}
        onDone={onChanged}
      />
    </Card>
  );
}
