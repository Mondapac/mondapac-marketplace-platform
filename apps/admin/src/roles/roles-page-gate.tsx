import { getTranslations } from 'next-intl/server';
import { SettingsShell } from '../server/settings-shell.tsx';
import type { AdminSession } from '../server/session.ts';

/** The no-access state of a roles page (ux B5), with a way home. */
export async function RolesNoAccess({ session }: { readonly session: AdminSession }) {
  const t = await getTranslations();
  return (
    <SettingsShell session={session} linkId="roles" title={t('identity.members.no-access.title')}>
      <h1 className="mb-2 text-2xl font-semibold">{t('identity.members.no-access.title')}</h1>
      <p className="text-fg-muted">{t('identity.members.no-access.body')}</p>
      <p className="mt-4">
        <a className="font-medium text-link underline" href="/">
          {t('identity.members.no-access.action')}
        </a>
      </p>
    </SettingsShell>
  );
}
