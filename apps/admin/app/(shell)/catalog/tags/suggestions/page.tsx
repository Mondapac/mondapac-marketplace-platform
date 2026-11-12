import { LoadError, NoAccess } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { REVIEW_PERMISSION } from '../../../../../src/tags/suggestion-types.ts';
import { SuggestionsView } from '../../../../../src/tags/suggestions-view.tsx';
import { MANAGE_PERMISSION } from '../../../../../src/tags/types.ts';
import { AdminShell } from '../../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../../src/server/session.ts';

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
          canApprove={permissionKeys.includes(MANAGE_PERMISSION)}
          csrfToken={csrfToken}
          noAccess={noAccess}
        />
      ) : (
        noAccess
      )}
    </AdminShell>
  );
}
