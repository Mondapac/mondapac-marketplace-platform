import { LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { ContentNoAccess } from '../../../../../../src/content/content-no-access.tsx';
import { SlidePlacementEditor } from '../../../../../../src/content/slides/slide-placement-editor.tsx';
import {
  SLIDE_EDIT_PERMISSION,
  SLIDE_PAUSE_PERMISSION,
  SLIDE_PUBLISH_PERMISSION,
  SLIDE_READ_PERMISSION,
  SLIDES_API_PATH,
  type SlideDetail,
} from '../../../../../../src/content/slides/slide-types.ts';
import { AdminShell } from '../../../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../../src/server/session.ts';
import { displayZone } from '../../../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('slides.placement.page-title') };
}

/** One slide: the Where and when tab, editable with the edit permission and read-only without it. */
export default async function SlidePlacementPage({
  params,
}: {
  readonly params: Promise<{ readonly slideId: string }>;
}) {
  const { slideId } = await params;
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone, csrfToken } = gate.session;
  if (!permissionKeys.includes(SLIDE_READ_PERMISSION)) {
    return <ContentNoAccess session={gate.session} />;
  }
  const read = await serverGet<SlideDetail>(`${SLIDES_API_PATH}/${encodeURIComponent(slideId)}`);
  if (read.kind === 'signed-out') redirect('/session-ended');
  // An unknown id and a slide of another Market look the same.
  if (read.kind === 'not-found') notFound();
  const title = t('content.title');
  if (read.kind !== 'ok') {
    return (
      <AdminShell session={gate.session} activeId="content" title={title}>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <LoadError message={t('content.unavailable')} retryLabel={t('load.retry')} />
      </AdminShell>
    );
  }
  return (
    <AdminShell session={gate.session} activeId="content" title={title}>
      <SlidePlacementEditor
        key={`${read.body.updatedAt}:${read.body.status}:${read.body.versions.length}`}
        slide={read.body}
        canEdit={permissionKeys.includes(SLIDE_EDIT_PERMISSION)}
        canPause={permissionKeys.includes(SLIDE_PAUSE_PERMISSION)}
        canPublish={permissionKeys.includes(SLIDE_PUBLISH_PERMISSION)}
        csrfToken={csrfToken}
        zone={displayZone(timezone)}
      />
    </AdminShell>
  );
}
