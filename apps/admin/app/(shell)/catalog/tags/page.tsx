import { LoadError, Tabs } from '@mondapac/ui';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { REVIEW_PERMISSION, SUGGESTIONS_PATH } from '../../../../src/tags/suggestion-types.ts';
import { TagsView } from '../../../../src/tags/tags-view.tsx';
import { MANAGE_PERMISSION, READ_PERMISSION, TAGS_PATH } from '../../../../src/tags/types.ts';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../src/server/bff.ts';
import { panelConfig } from '../../../../src/server/config.ts';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { localZone } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('tags.title') };
}

export default async function TagsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  // List paging (settings): page numbers only when the Market says so; unreadable means Previous and next.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  const title = t('tags.title');
  const { permissionKeys, csrfToken } = gate.session;
  return (
    <AdminShell session={gate.session} activeId="tags" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {permissionKeys.includes(READ_PERMISSION) && permissionKeys.includes(REVIEW_PERMISSION) ? (
        <div className="mb-4">
          <Tabs
            label={t('tags.suggestions.tabs')}
            activeId="tags"
            items={[
              { id: 'tags', label: t('tags.suggestions.tab.tags'), href: TAGS_PATH },
              {
                id: 'suggestions',
                label: t('tags.suggestions.tab.suggestions'),
                href: SUGGESTIONS_PATH,
              },
            ]}
          />
        </div>
      ) : null}
      {permissionKeys.includes(READ_PERMISSION) ? (
        <TagsView
          canManage={permissionKeys.includes(MANAGE_PERMISSION)}
          csrfToken={csrfToken}
          paging={paging}
          accountId={gate.session.accountId}
          marketId={marketId}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        />
      ) : (
        <>
          <p className="text-fg-muted">{t('tags.no-access')}</p>
          <p className="mt-4">
            <a className="font-medium text-link underline" href="/">
              {t('tags.back-home')}
            </a>
          </p>
        </>
      )}
    </AdminShell>
  );
}
