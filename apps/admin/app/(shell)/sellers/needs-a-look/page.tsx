import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../../src/server/server-fetch.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { HealthQueue } from '../../../../src/sellers/health-queue.tsx';
import {
  HEALTH_QUEUE_PATH,
  SELLER_VIEW_PERMISSION,
  type HealthQueueRead,
} from '../../../../src/sellers/health-types.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('sellers.health-queue.title') };
}

export default async function SellersNeedingALookPage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const title = t('sellers.health-queue.title');
  const back = (
    <a
      className="mb-1 inline-flex min-h-12 items-center font-medium text-link underline"
      href="/sellers"
    >
      {t('sellers.health-queue.back')}
    </a>
  );
  let body: React.ReactNode;
  if (!gate.session.permissionKeys.includes(SELLER_VIEW_PERMISSION)) {
    body = (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-line p-6">
        <h1 className="text-xl font-semibold">{t('sellers.health-queue.no-access.title')}</h1>
        <p className="text-fg-muted">{t('sellers.health-queue.no-access.body')}</p>
      </div>
    );
  } else {
    const read = await serverGet<HealthQueueRead>(HEALTH_QUEUE_PATH);
    if (read.kind === 'signed-out') redirect('/session-ended');
    body =
      read.kind === 'ok' ? (
        <>
          {/* An empty queue is a page-size empty state, whose title is the h1. */}
          {read.body.items.length === 0 ? null : (
            <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
          )}
          <HealthQueue queue={read.body} />
        </>
      ) : (
        <>
          <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
          <LoadError message={t('sellers.health-queue.unavailable')} retryLabel={t('load.retry')} />
        </>
      );
  }
  return (
    <AdminShell session={gate.session} activeId="sellers" title={title}>
      {back}
      {body}
    </AdminShell>
  );
}
