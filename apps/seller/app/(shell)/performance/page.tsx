import { EmptyState } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { Performance } from '../../../src/performance/performance.tsx';
import { HEALTH_PATH, type OwnHealth } from '../../../src/performance/types.ts';
import { loadOwnPage } from '../../../src/server/own-page.ts';
import { SellerShell } from '../../../src/server/seller-shell.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('performance.title') };
}

export default async function PerformancePage() {
  const t = await getTranslations();
  const title = t('performance.title');
  const page = await loadOwnPage<OwnHealth>(HEALTH_PATH);
  if (page.kind === 'unavailable') {
    return (
      <main className="mx-auto max-w-3xl p-6">
        <EmptyState
          size="page"
          icon="alert-circle"
          title={t('performance.unavailable.title')}
          body={t('performance.unavailable.body')}
        />
      </main>
    );
  }
  if (page.kind === 'not-found') {
    return (
      <SellerShell session={page.session} activeId="s_performance" title={title}>
        <EmptyState
          size="page"
          icon="star"
          title={t('performance.empty.title')}
          body={t('performance.empty.body')}
        />
      </SellerShell>
    );
  }
  return (
    <SellerShell session={page.session} activeId="s_performance" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <Performance initial={page.body} csrfToken={page.session.csrfToken} />
    </SellerShell>
  );
}
