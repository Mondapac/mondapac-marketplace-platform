import { EmptyState, LinkButton } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { CreditForm } from '../../../../src/wallet/credit-form.tsx';
import { CREDIT_ISSUE, CREDIT_VIEW, SETTINGS_VIEW } from '../../../../src/wallet/types.ts';
import { WalletPage } from '../../../../src/wallet/wallet-page.tsx';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('wallet.credit.title') };
}

export default async function IssueCreditPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly customer?: string | readonly string[] }>;
}) {
  const { customer } = await searchParams;
  const t = await getTranslations();
  const given = typeof customer === 'string' && customer !== '';
  const valid = given && UUID.test(customer);
  return (
    <WalletPage
      activeId="wallet-credits"
      title={t('wallet.credit.title')}
      intro={t('wallet.credit.intro')}
      anyOf={[CREDIT_VIEW]}
      stepUpNote
      body={(session, keys) =>
        valid ? (
          <CreditForm
            // A new customer is a new form: its own key, fields and summary.
            key={customer}
            customerId={customer}
            canIssue={keys.has(CREDIT_ISSUE)}
            canViewSettings={keys.has(SETTINGS_VIEW)}
            canViewRequests={keys.has(CREDIT_VIEW)}
            csrfToken={session.csrfToken}
          />
        ) : (
          <EmptyState
            icon="users"
            title={t('wallet.credit.choose.title')}
            body={given ? t('wallet.credit.choose.invalid') : t('wallet.credit.choose.body')}
            action={<LinkButton href="/customers">{t('wallet.credit.choose.action')}</LinkButton>}
          />
        )
      }
    />
  );
}
