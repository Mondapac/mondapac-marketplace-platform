import { LinkButton, LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { redirect } from 'next/navigation';
import { ContentNoAccess } from '../../../src/content/content-no-access.tsx';
import { ContentTabs } from '../../../src/content/content-tabs.tsx';
import {
  NEW_PAGE_PATH,
  PAGE_CREATE_PERMISSION,
  PAGE_EDIT_PERMISSION,
  PAGE_READ_PERMISSION,
} from '../../../src/content/pages/page-types.ts';
import { PagesList } from '../../../src/content/pages/pages-list.tsx';
import { SLIDES_PATH, SLIDE_READ_PERMISSION } from '../../../src/content/slides/slide-types.ts';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../src/server/session.ts';
import { displayZone } from '../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations('content');
  return { title: t('title') };
}

/** Content opens on Pages; a role that can read slides only goes straight to Slides. */
export default async function ContentPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone } = gate.session;
  if (!permissionKeys.includes(PAGE_READ_PERMISSION)) {
    if (permissionKeys.includes(SLIDE_READ_PERMISSION)) redirect(SLIDES_PATH);
    return <ContentNoAccess session={gate.session} />;
  }
  const title = t('content.title');
  return (
    <AdminShell session={gate.session} activeId="content" title={title}>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{title}</h1>
          <p className="text-fg-muted">{t('content.intro')}</p>
        </div>
        {permissionKeys.includes(PAGE_CREATE_PERMISSION) ? (
          <LinkButton href={NEW_PAGE_PATH}>{t('content.pages.list.new')}</LinkButton>
        ) : null}
      </div>
      <ContentTabs
        active="pages"
        permissionKeys={permissionKeys}
        labels={{
          nav: t('content.tabs.label'),
          pages: t('content.tabs.pages'),
          slides: t('content.tabs.slides'),
        }}
      />
      <PagesList
        canEdit={permissionKeys.includes(PAGE_EDIT_PERMISSION)}
        canCreate={permissionKeys.includes(PAGE_CREATE_PERMISSION)}
        zone={displayZone(timezone)}
      />
    </AdminShell>
  );
}
