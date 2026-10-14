import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { SupportEmailCard } from '../../../src/settings/support-email-card.tsx';
import {
  SUPPORT_MANAGE_PERMISSION,
  SUPPORT_VIEW_PERMISSION,
  type SupportContact,
} from '../../../src/settings/types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('settings.title') };
}

export default async function SettingsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('settings.title');
  const { permissionKeys, csrfToken } = gate.session;
  const shell = (body: React.ReactNode) => (
    <AdminShell session={gate.session} activeId="settings" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {body}
    </AdminShell>
  );
  if (!permissionKeys.includes(SUPPORT_VIEW_PERMISSION)) {
    return shell(
      <>
        <p className="text-fg-muted">{t('settings.no-access')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('settings.back-home')}
          </a>
        </p>
      </>,
    );
  }
  const read = await serverGet<SupportContact>('notifications/admin/support-contact');
  if (read.kind === 'signed-out') redirect('/session-ended');
  if (read.kind !== 'ok') {
    return shell(<LoadError message={t('settings.unavailable')} retryLabel={t('load.retry')} />);
  }
  return shell(
    <SupportEmailCard
      initial={read.body}
      canManage={permissionKeys.includes(SUPPORT_MANAGE_PERMISSION)}
      csrfToken={csrfToken}
    />,
  );
}
