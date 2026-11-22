import { LoadError, workQueueRows } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { panelHostFor } from '../../../src/server/bff.ts';
import { panelConfig } from '../../../src/server/config.ts';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { WorkQueueList } from '../../../src/work-queue/work-queue-list.tsx';
import { isView } from '../../../src/work-queue/work-queue-query.ts';
import {
  adminQueue,
  mayHaveWorkQueue,
  WORK_QUEUE_PATH,
  type WorkQueueAnswer,
} from '../../../src/work-queue/queues.ts';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('work-queue.page.title') };
}

const one = (value: string | readonly string[] | undefined): string | undefined =>
  typeof value === 'string' ? value : undefined;

/**
 * The full work queue (dashboards upgrade phase 2): every queue the admin may see, read once from
 * `GET dashboard/admin/work-queue`. A link may open a view (`?view=critical|today|review|all`).
 * The route has no key of its own: an admin without any queue's key sees the empty state.
 */
export default async function WorkQueuePage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly view?: string | readonly string[] }>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const asked = one((await searchParams).view);
  const view = isView(asked) ? asked : 'needs-action';
  const title = t('work-queue.page.title');
  // Without a key of any queue the API answers an empty list: say there is no access, not "All
  // clear" (Sajad, QA), and do not ask at all.
  const answer = mayHaveWorkQueue(gate.session.permissionKeys)
    ? await serverGet<WorkQueueAnswer>(WORK_QUEUE_PATH)
    : ({ kind: 'forbidden' } as const);
  if (answer.kind === 'signed-out') redirect('/session-ended');
  const known =
    answer.kind === 'ok' &&
    workQueueRows(answer.body, (key) =>
      adminQueue(key) === null ? null : { label: key, href: null, signal: 'age' },
    ).length > 0;
  const back = (
    <a className="mb-1 inline-flex min-h-12 items-center font-medium text-link underline" href="/">
      {t('work-queue.page.back')}
    </a>
  );
  let body: React.ReactNode;
  if (answer.kind === 'forbidden' || (answer.kind === 'ok' && !known)) {
    body = (
      <div className="flex flex-col items-start gap-3 rounded-lg border border-line p-6">
        <h1 className="text-xl font-semibold">{t('work-queue.page.no-access.title')}</h1>
        <p className="text-fg-muted">{t('work-queue.page.no-access.body')}</p>
      </div>
    );
  } else if (answer.kind !== 'ok') {
    body = (
      <>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <LoadError className="" message={t('work-queue.page.error')} retryLabel={t('load.retry')} />
      </>
    );
  } else {
    const marketId = panelHostFor(panelConfig(), (await headers()).get('host'))?.marketId ?? '';
    body = (
      <>
        <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
        <WorkQueueList
          answer={answer.body}
          initialView={view}
          accountId={gate.session.accountId}
          marketId={marketId}
        />
      </>
    );
  }
  return (
    <AdminShell session={gate.session} activeId="home" title={title}>
      {back}
      {body}
    </AdminShell>
  );
}
