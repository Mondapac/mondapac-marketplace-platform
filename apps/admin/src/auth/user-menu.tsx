'use client';

import { Banner, Button } from '@mondapac/ui';
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
  const [failed, setFailed] = useState(false);

  async function signOut() {
    setPending(true);
    setFailed(false);
    const result = await callApi('POST', 'identity/admin/sign-out', {}, csrfToken);
    // Signed out, or the session was already gone: both end on the sign-in page. Anything else
    // means the session may still be live, so the page says so and stays.
    if (result.ok || result.failure.status === 401) {
      router.replace('/sign-in?notice=signed-out');
      router.refresh();
      return;
    }
    setPending(false);
    setFailed(true);
  }

  return (
    <div className="flex items-center gap-3" role="group" aria-label={t('user-menu')}>
      {failed ? <Banner tone="critical">{t('sign-out-failed')}</Banner> : null}
      <span className="text-sm text-fg-secondary">{t('signed-in-as', { name })}</span>
      <Button variant="secondary" onClick={() => void signOut()} loading={pending}>
        {t('sign-out')}
      </Button>
    </div>
  );
}
