import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { ContentNoAccess } from '../../../../../src/content/content-no-access.tsx';
import { NewPageFormView } from '../../../../../src/content/pages/new-page-form.tsx';
import {
  PAGE_CREATE_PERMISSION,
  PAGE_READ_PERMISSION,
} from '../../../../../src/content/pages/page-types.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';
import { displayZone } from '../../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('pages.new.title') };
}

/** A new page: needs both the read and the create permission. */
export default async function NewPagePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone, csrfToken } = gate.session;
  if (
    !permissionKeys.includes(PAGE_READ_PERMISSION) ||
    !permissionKeys.includes(PAGE_CREATE_PERMISSION)
  ) {
    return <ContentNoAccess session={gate.session} />;
  }
  return (
    <AdminShell session={gate.session} activeId="content" title={t('content.title')}>
      <NewPageFormView csrfToken={csrfToken} zone={displayZone(timezone)} />
    </AdminShell>
  );
}
