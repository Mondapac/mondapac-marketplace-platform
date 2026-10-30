import { LoadError } from '@mondapac/ui';
import { redirect } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { SellerShell } from '../../../src/server/seller-shell.tsx';
import { serverGet } from '../../../src/server/server-fetch.ts';
import { requireSession } from '../../../src/server/session.ts';
import { SETUP_ROOT } from '../../../src/setup/steps.ts';
import { InviteMemberButton } from '../../../src/team/invite-member-button.tsx';
import { TeamTable } from '../../../src/team/team-table.tsx';
import {
  ROLE_VIEW_PERMISSION,
  TEAM_ASSIGN_PERMISSION,
  TEAM_INVITE_PERMISSION,
  TEAM_VIEW_PERMISSION,
  type SellerRole,
  type TeamPage,
} from '../../../src/team/types.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('identity.team.title') };
}

export default async function TeamPageRoute({
  searchParams,
}: {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  // The team is for an approved seller; the others finish their file first.
  if (session.sellerAccessState !== 'approved') redirect(SETUP_ROOT);
  const title = t('identity.team.title');
  if (!session.permissionKeys.includes(TEAM_VIEW_PERMISSION)) {
    return (
      <SellerShell session={session} activeId="s_home" title={t('identity.team.no-access.title')}>
        <h1 className="mb-2 text-2xl font-semibold">{t('identity.team.no-access.title')}</h1>
        <p className="text-fg-muted">{t('identity.team.no-access.body')}</p>
        <p className="mt-4">
          <a className="font-medium text-link underline" href="/">
            {t('identity.team.no-access.action')}
          </a>
        </p>
      </SellerShell>
    );
  }
  const { after: rawAfter } = await searchParams;
  const after = typeof rawAfter === 'string' && UUID.test(rawAfter) ? rawAfter : null;
  // Each action shows only to an actor who holds its key; the server checks every command again.
  const keys = new Set(session.permissionKeys);
  const canAssign = keys.has(TEAM_ASSIGN_PERMISSION);
  const canInvite = keys.has(TEAM_INVITE_PERMISSION);
  const canReadRoles = keys.has(ROLE_VIEW_PERMISSION);
  const [result, rolesResult] = await Promise.all([
    serverGet<TeamPage>(`identity/seller/team${after === null ? '' : `?after=${after}`}`),
    canReadRoles
      ? serverGet<{ readonly items: readonly SellerRole[] }>('identity/seller/roles')
      : Promise.resolve(null),
  ]);
  if (result.kind === 'signed-out' || rolesResult?.kind === 'signed-out') {
    redirect('/session-ended');
  }
  // Without the role list the role actions are left out, not shown broken.
  const roles = rolesResult?.kind === 'ok' ? rolesResult.body.items : undefined;
  return (
    <SellerShell session={session} activeId="s_team" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      {result.kind === 'ok' ? (
        <>
          {canInvite && roles !== undefined ? (
            <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:justify-end">
              <InviteMemberButton roles={roles} csrfToken={session.csrfToken} />
            </div>
          ) : null}
          <TeamTable
            page={result.body}
            after={after}
            csrfToken={session.csrfToken}
            roles={canAssign ? roles : undefined}
            roleList={roles ?? []}
          />
          {result.body.next === null || !UUID.test(result.body.next) ? null : (
            <p className="mt-4">
              <a
                className="inline-flex min-h-12 items-center font-medium text-link underline"
                href={`/team?after=${result.body.next}`}
              >
                {t('identity.team.next-page')}
              </a>
            </p>
          )}
        </>
      ) : (
        <LoadError message={t('identity.error.unknown')} retryLabel={t('load.retry')} />
      )}
    </SellerShell>
  );
}
