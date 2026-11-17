import { LoadError } from '@mondapac/ui';
import { notFound, redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../server/admin-shell.tsx';
import { serverGet } from '../../server/server-fetch.ts';
import { requireSession } from '../../server/session.ts';
import { displayZone } from '../../shared/format.ts';
import { ContentNoAccess } from '../content-no-access.tsx';
import { PageContent } from './page-content.tsx';
import { PageVersions } from './page-versions.tsx';
import { PageSettings } from './page-settings.tsx';
import {
  PAGE_ARCHIVE_PERMISSION,
  PAGE_EDIT_PERMISSION,
  PAGE_PUBLISH_PERMISSION,
  PAGE_READ_PERMISSION,
  PAGES_API_PATH,
  type PageDetail,
} from './page-types.ts';

/**
 * One page of the page editor, on the tab it is opened on: the gate (the read permission), the
 * read of the page, and the Content, Settings or Versions tab. The edit permission only turns the controls
 * on; an unknown page, the navigation page (it has its own tab) and a page of another Market look
 * the same: not found.
 */
export async function PageRoute({
  page,
  tab,
}: {
  readonly page: string;
  readonly tab: 'content' | 'settings' | 'versions';
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone, csrfToken } = gate.session;
  if (!permissionKeys.includes(PAGE_READ_PERMISSION)) {
    return <ContentNoAccess session={gate.session} />;
  }
  if (page === 'navigation') notFound();
  const read = await serverGet<PageDetail>(`${PAGES_API_PATH}/${encodeURIComponent(page)}`);
  if (read.kind === 'signed-out') redirect('/session-ended');
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
  const body = read.body;
  const canEdit = permissionKeys.includes(PAGE_EDIT_PERMISSION);
  const canPublish = permissionKeys.includes(PAGE_PUBLISH_PERMISSION);
  const canArchive = permissionKeys.includes(PAGE_ARCHIVE_PERMISSION);
  const zone = displayZone(timezone);
  // A new key after a refresh shows the page as it is now (a refused change that found it changed).
  const key = `${body.updatedAt}:${body.draft.updatedAt}:${body.publishedVersionNo}:${body.status}`;
  return (
    <AdminShell session={gate.session} activeId="content" title={title}>
      {tab === 'content' ? (
        <PageContent
          key={key}
          page={body}
          canEdit={canEdit}
          canPublish={canPublish}
          canArchive={canArchive}
          csrfToken={csrfToken}
          zone={zone}
        />
      ) : tab === 'settings' ? (
        <PageSettings
          key={key}
          page={body}
          canEdit={canEdit}
          canPublish={canPublish}
          canArchive={canArchive}
          csrfToken={csrfToken}
          zone={zone}
        />
      ) : (
        <PageVersions
          key={key}
          page={body}
          canEdit={canEdit}
          canPublish={canPublish}
          canArchive={canArchive}
          csrfToken={csrfToken}
          zone={zone}
        />
      )}
    </AdminShell>
  );
}
