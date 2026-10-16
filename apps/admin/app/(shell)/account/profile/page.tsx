import { Badge, Card, DataList, EmailText, LoadError } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { DisplayNameCard } from '../../../../src/profile/display-name-card.tsx';
import { PasswordCard } from '../../../../src/profile/password-card.tsx';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { panelConfig } from '../../../../src/server/config.ts';
import { requireSession } from '../../../../src/server/session.ts';
import { formatInstant } from '../../../../src/shared/format.ts';

export async function generateMetadata() {
  const t = await getTranslations('profile');
  return { title: t('title') };
}

/** My profile: the signed-in user's own details, opened from the account menu. */
export default async function ProfilePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  const locale = await getLocale();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('profile.unavailable')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const title = t('profile.title');
  const config = panelConfig();
  const status = session.secondFactorActive ? (
    <Badge tone="success">{t('profile.two-step-on')}</Badge>
  ) : (
    <Badge tone="attention">{t('profile.two-step-off')}</Badge>
  );
  return (
    <AdminShell session={session} activeId="account" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <Card title={t('profile.details')}>
        <DataList
          missing={t('profile.missing')}
          rows={[
            { label: t('profile.name'), value: session.displayName },
            { label: t('profile.email'), value: <EmailText address={session.email} /> },
            {
              label: t('profile.two-step'),
              value: status,
            },
            {
              label: t('profile.last-sign-in'),
              value:
                session.lastSignInAt === null ? (
                  <span className="text-fg-muted">{t('profile.last-sign-in-none')}</span>
                ) : (
                  <time dateTime={session.lastSignInAt}>
                    {formatInstant(session.lastSignInAt, locale)}
                  </time>
                ),
            },
          ]}
        />
      </Card>
      <div className="mt-6 flex flex-col gap-6">
        <DisplayNameCard initial={session.displayName} csrfToken={session.csrfToken} />
        <PasswordCard
          csrfToken={session.csrfToken}
          passwordMin={config.passwordMinLength}
          passwordMax={config.passwordMaxLength}
        />
      </div>
    </AdminShell>
  );
}
