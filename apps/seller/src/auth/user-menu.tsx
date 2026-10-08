'use client';

import { Button } from '@mondapac/ui';
import { useTranslations } from 'next-intl';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { callApi } from '../api/client.ts';

export function UserMenu({
  name,
  csrfToken,
}: {
  readonly name: string;
  readonly csrfToken: string;
}) {
  const t = useTranslations('home');
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function signOut() {
    setPending(true);
    await callApi('POST', 'identity/seller/sign-out', {}, csrfToken);
    // Signed out or already ended: either way the next stop is the sign-in page.
    router.replace('/sign-in?notice=signed-out');
    router.refresh();
  }

  return (
    <div className="flex items-center gap-3" role="group" aria-label={t('user-menu')}>
      <span className="text-sm text-fg-secondary">{t('signed-in-as', { name })}</span>
      <Button variant="secondary" onClick={() => void signOut()} disabled={pending}>
        {t('sign-out')}
      </Button>
    </div>
  );
}
