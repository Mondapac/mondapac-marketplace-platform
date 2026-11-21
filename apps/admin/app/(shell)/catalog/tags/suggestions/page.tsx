import { LoadError, NoAccess } from '@mondapac/ui';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { REVIEW_PERMISSION } from '../../../../../src/tags/suggestion-types.ts';
import { SuggestionsView } from '../../../../../src/tags/suggestions-view.tsx';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../../../src/server/bff.ts';
import { panelConfig } from '../../../../../src/server/config.ts';
import { serverGet } from '../../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../../src/server/session.ts';
import { localZone } from '../../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('tags.suggestions.title') };
}

/**
 * Catalogue > Tags > Suggestions (product tags T5b): the tags that sellers ask for. Needs
 * `catalog.topic-suggestion.review`; approving also needs `catalog.topic.manage`.
 */
export default async function TagSuggestionsPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  // List paging (settings): page numbers only when the Market says so; unreadable means Previous and next.
  const mode = await serverGet<{ readonly listPaging: string }>('settings/admin/list-paging');
  const paging = mode.kind === 'ok' && mode.body.listPaging === 'pages' ? 'pages' : 'prev-next';
  const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
  const title = t('tags.suggestions.title');
  const { permissionKeys, csrfToken } = gate.session;
  const noAccess = (
    <NoAccess
      title={t('tags.suggestions.no-access.title')}
      body={t('tags.suggestions.no-access.body')}
      backHref="/"
      backLabel={t('tags.back-home')}
      pageTitle={title}
    />
  );
  return (
    <AdminShell session={gate.session} activeId="tags" title={title}>
      {permissionKeys.includes(REVIEW_PERMISSION) ? (
        <SuggestionsView
          csrfToken={csrfToken}
          paging={paging}
          accountId={gate.session.accountId}
          marketId={marketId}
          zone={localZone(gate.session.timezone, gate.session.marketTimezone)}
        />
      ) : (
        noAccess
      )}
    </AdminShell>
  );
}
