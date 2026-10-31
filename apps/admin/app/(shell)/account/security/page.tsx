import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AccountSecurity } from '../../../../src/security/account-security.tsx';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations('security');
  return { title: t('title') };
}

/** Account security: the admin's own two-step status and authenticator, from the account menu. */
export default async function SecurityPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('security.unavailable')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  return (
    <AdminShell session={session} activeId="account" title={t('security.title')}>
      <AccountSecurity active={session.secondFactorActive} csrfToken={session.csrfToken} />
    </AdminShell>
  );
}
