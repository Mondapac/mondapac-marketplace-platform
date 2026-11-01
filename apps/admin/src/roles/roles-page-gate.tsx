import { NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { SettingsShell } from '../server/settings-shell.tsx';
import type { AdminSession } from '../server/session.ts';

/** The no-access state of a roles page (ux B5), with a way back to Settings. */
export async function RolesNoAccess({ session }: { readonly session: AdminSession }) {
  const t = await getTranslations();
  return (
    <SettingsShell session={session} linkId="roles" title={t('identity.members.title.admin')}>
      <NoAccess
        pageTitle={t('identity.members.title.admin')}
        title={t('identity.members.no-access.title')}
        body={t('identity.members.no-access.body')}
        backHref="/settings"
        backLabel={t('settings.sub.back')}
      />
    </SettingsShell>
  );
}
