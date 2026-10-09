import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../src/server/admin-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { NoticeProvider } from '../../../src/team/notice.tsx';
import { TeamTable } from '../../../src/team/team-table.tsx';
import type { TeamPage } from '../../../src/team/types.ts';

const VIEW_PERMISSION = 'identity.admin-account.view';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('identity.members.title.admin') };
}

export default async function TeamPageRoute({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <p className="p-6 text-fg-muted">{t('identity.error.unknown')}</p>;
  }
  if (!gate.session.permissionKeys.includes(VIEW_PERMISSION)) {
    return (
      <AdminShell
        session={gate.session}
        activeId="home"
        title={t('identity.members.no-access.title')}
      >
        <h1 className="mb-2 text-2xl font-semibold">{t('identity.members.no-access.title')}</h1>
        <p className="text-fg-muted">{t('identity.members.no-access.body')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('identity.members.no-access.action')}
          </a>
        </p>
      </AdminShell>
    );
  }
  const { after: rawAfter } = await searchParams;
  const after = typeof rawAfter === 'string' && UUID.test(rawAfter) ? rawAfter : null;
  const title = t('identity.members.title.admin');
  const result = await serverGet<TeamPage>(
    `identity/admin/team${after === null ? '' : `?after=${after}`}`,
  );
  if (result.kind === 'signed-out') redirect('/session-ended');
  return (
    <AdminShell session={gate.session} activeId="team" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {result.kind === 'ok' ? (
        <>
          <NoticeProvider>
            <TeamTable page={result.body} after={after} csrfToken={gate.session.csrfToken} />
          </NoticeProvider>
          {result.body.next === null || !UUID.test(result.body.next) ? null : (
            <p className="mt-4">
              <a
                className="font-medium text-link underline"
                href={`/team?after=${result.body.next}`}
              >
                {t('identity.members.next-page')}
              </a>
            </p>
          )}
        </>
      ) : (
        <p className="text-fg-muted">{t('identity.error.unknown')}</p>
      )}
    </AdminShell>
  );
}
