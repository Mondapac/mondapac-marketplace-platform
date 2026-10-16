import { Badge, Card, DataList, EmailText, LoadError } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { AdminShell } from '../../../../src/server/admin-shell.tsx';
import { requireSession } from '../../../../src/server/session.ts';

export async function generateMetadata() {
  const t = await getTranslations('profile');
  return { title: t('title') };
}

/** My profile: the signed-in user's own details, opened from the account menu. */
export default async function ProfilePage() {
  const gate = await requireSession();
  const t = await getTranslations();
  if (gate.kind === 'unavailable') {
    return <LoadError message={t('profile.unavailable')} retryLabel={t('load.retry')} />;
  }
  const { session } = gate;
  const title = t('profile.title');
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
          ]}
        />
      </Card>
    </AdminShell>
  );
}
