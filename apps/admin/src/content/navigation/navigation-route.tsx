import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../server/admin-shell.tsx';
import { serverGet } from '../../server/server-fetch.ts';
import { requireSession } from '../../server/session.ts';
import { displayZone } from '../../shared/format.ts';
import { ContentNoAccess } from '../content-no-access.tsx';
import { ContentTabs } from '../content-tabs.tsx';
import type { PageDetail } from '../pages/page-types.ts';
import {
  NAVIGATION_API_PATH,
  NAV_APPROVE_PERMISSION,
  NAV_EDIT_PERMISSION,
  NAV_READ_PERMISSION,
} from './nav-form.ts';
import { NavigationEditor } from './navigation-editor.tsx';

/**
 * The Navigation tab of Content: the gate (the page read permission), the read of the navigation
 * and the editor. The edit and approve keys only turn the controls on; the API checks them.
 */
export async function NavigationRoute() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { permissionKeys, timezone, csrfToken } = gate.session;
  if (!permissionKeys.includes(NAV_READ_PERMISSION)) {
    return <ContentNoAccess session={gate.session} />;
  }
  const title = t('content.title');
  const read = await serverGet<PageDetail>(NAVIGATION_API_PATH);
  if (read.kind === 'signed-out') redirect('/session-ended');
  const body = read.kind === 'ok' ? read.body : null;
  return (
    <AdminShell session={gate.session} activeId="content" title={title}>
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">{title}</h1>
        <p className="text-fg-muted">{t('content.navigation.intro')}</p>
      </div>
      <ContentTabs
        active="navigation"
        permissionKeys={permissionKeys}
        labels={{
          nav: t('content.tabs.label'),
          pages: t('content.tabs.pages'),
          navigation: t('content.tabs.navigation'),
          slides: t('content.tabs.slides'),
        }}
      />
      {body === null ? (
        <LoadError message={t('content.unavailable')} retryLabel={t('load.retry')} />
      ) : (
        <NavigationEditor
          // A new key after a refresh shows the navigation as it is now.
          key={`${body.updatedAt}:${body.draft.updatedAt}:${body.publishedVersionNo}`}
          page={body}
          canEdit={permissionKeys.includes(NAV_EDIT_PERMISSION)}
          canApprove={permissionKeys.includes(NAV_APPROVE_PERMISSION)}
          csrfToken={csrfToken}
          zone={displayZone(timezone)}
        />
      )}
    </AdminShell>
  );
}
