import { LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { ContentNoAccess } from '../../../../../src/content/content-no-access.tsx';
import { SlideEditor } from '../../../../../src/content/slides/slide-editor.tsx';
import {
  SLIDE_EDIT_PERMISSION,
  SLIDE_READ_PERMISSION,
} from '../../../../../src/content/slides/slide-types.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';
import { displayZone } from '../../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('slides.editor.title-new') };
}

/** A new slide: the Content tab, empty. Needs both the read and the edit permission. */
export default async function NewSlidePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone, csrfToken } = gate.session;
  if (
    !permissionKeys.includes(SLIDE_READ_PERMISSION) ||
    !permissionKeys.includes(SLIDE_EDIT_PERMISSION)
  ) {
    return <ContentNoAccess session={gate.session} />;
  }
  return (
    <AdminShell session={gate.session} activeId="content" title={t('content.title')}>
      <SlideEditor slide={null} canEdit csrfToken={csrfToken} zone={displayZone(timezone)} />
    </AdminShell>
  );
}
