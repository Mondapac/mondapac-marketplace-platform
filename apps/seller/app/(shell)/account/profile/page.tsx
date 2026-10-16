import { Badge, Card, DataList, EmailText, LoadError } from '@mondapac/ui';
import { getLocale, getTranslations } from 'next-intl/server';
import { formatInstant } from '../../../../src/catalog/format.ts';
import { DisplayNameCard } from '../../../../src/profile/display-name-card.tsx';
import { PasswordCard } from '../../../../src/profile/password-card.tsx';
import { SellerShell } from '../../../../src/server/seller-shell.tsx';
import { panelConfig } from '../../../../src/server/config.ts';
import { readSellerZone } from '../../../../src/server/seller-zone.ts';
import { requireSession } from '../../../../src/server/session.ts';

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
  const zone = await readSellerZone();
  const status = session.secondFactorActive ? (
    <Badge tone="success">{t('profile.two-step-on')}</Badge>
  ) : (
    <Badge tone="attention">{t('profile.two-step-off')}</Badge>
  );
  return (
    <SellerShell session={session} activeId="account" title={title}>
      <h1 className="mb-4 text-2xl font-semibold">{title}</h1>
      <Card title={t('profile.details')}>
        <DataList
          missing={t('profile.missing')}
          rows={[
            { label: t('profile.name'), value: session.displayName },
            { label: t('profile.email'), value: <EmailText address={session.email} /> },
            {
              label: t('profile.two-step'),
              value:
                session.sellerAccessState === 'approved' ? (
                  <span className="flex flex-wrap items-center gap-3">
                    {status}
                    <a className="font-medium text-link underline" href="/account/security">
                      {t('profile.manage-security')}
                    </a>
                  </span>
                ) : (
                  status
                ),
            },
            {
              label: t('profile.last-sign-in'),
              value:
                session.lastSignInAt === null ? (
                  <span className="text-fg-muted">{t('profile.last-sign-in-none')}</span>
                ) : (
                  <time dateTime={session.lastSignInAt}>
                    {formatInstant(session.lastSignInAt, locale, zone)}
                  </time>
                ),
            },
          ]}
        />
      </Card>
      <div className="mt-6 flex flex-col gap-6">
        <DisplayNameCard initial={session.displayName} csrfToken={session.csrfToken} />
        <PasswordCard
          codeRequired={session.secondFactorActive}
          csrfToken={session.csrfToken}
          passwordMin={config.passwordMinLength}
          passwordMax={config.passwordMaxLength}
        />
      </div>
    </SellerShell>
  );
}
