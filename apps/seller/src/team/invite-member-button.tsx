'use client';

import { Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useState } from 'react';
import { InviteMemberDialog } from './role-dialog.tsx';
import type { SellerRole } from './types.ts';

/** The primary action of the team page. Shown only to an actor who may invite. */
export function InviteMemberButton({
  roles,
  csrfToken,
}: {
  readonly roles: readonly SellerRole[];
  readonly csrfToken: string;
}) {
  const t = useTranslations('identity.team');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button className="w-full sm:w-auto" onClick={() => setOpen(true)}>
        {t('action.invite-member')}
      </Button>
      <InviteMemberDialog
        open={open}
        onClose={() => setOpen(false)}
        roles={roles}
        csrfToken={csrfToken}
      />
    </>
  );
}
