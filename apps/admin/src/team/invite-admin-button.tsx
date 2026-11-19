'use client';

import { Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { InviteAdminDialog } from './role-dialog.tsx';
import type { PlatformRole } from './types.ts';

/** The primary action of B1 (ux 3.2): "Invite admin". Shown only to an actor who may invite. */
export function InviteAdminButton({
  roles,
  csrfToken,
  reviewed = false,
}: {
  readonly roles: readonly PlatformRole[];
  readonly csrfToken: string;
  /** The Market reviews invitations (`review` of the team list): the dialog asks for a note. */
  readonly reviewed?: boolean;
}) {
  const t = useTranslations('identity.members');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('action.invite-admin')}</Button>
      <InviteAdminDialog
        open={open}
        onClose={() => setOpen(false)}
        roles={roles}
        csrfToken={csrfToken}
        reviewed={reviewed}
      />
    </>
  );
}
