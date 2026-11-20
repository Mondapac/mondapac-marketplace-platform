'use client';

import { Menu, type MenuItem } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';

/**
 * The row menu of a role: every action of the row lives here, none beside it. Open, edit and
 * duplicate only navigate (confirmation level 1), so none asks for a dialog. Delete stays in the
 * editor, where the review note is asked for.
 */
export function RoleRowActions({
  roleId,
  name,
  editable,
  canDuplicate,
}: {
  readonly roleId: string;
  readonly name: string;
  /** A custom role the actor may edit: the first item opens the editor instead of the read-only view. */
  readonly editable: boolean;
  readonly canDuplicate: boolean;
}) {
  const t = useTranslations('identity');
  const router = useRouter();
  const items: MenuItem[] = [
    {
      id: editable ? 'edit' : 'view',
      label: t(editable ? 'roles.action.edit-role' : 'roles.action.view-role'),
      onSelect: () => router.push(`/settings/roles/${roleId}`),
    },
  ];
  if (canDuplicate) {
    items.push({
      id: 'duplicate',
      label: t('roles.action.duplicate-role'),
      onSelect: () => router.push(`/settings/roles/new?from=${roleId}`),
    });
  }
  return <Menu label={t('members.actions-for', { name })} items={items} />;
}
