import { Tabs } from '@mondapac/ui';
import { getTranslations } from 'next-intl/server';
import { RequestsQueue } from '../../../../src/wallet/requests-queue.tsx';
import {
  CREDIT_APPROVE,
  CREDIT_VIEW,
  QUEUE_TABS,
  type QueueTab,
} from '../../../../src/wallet/types.ts';
import { WalletPage } from '../../../../src/wallet/wallet-page.tsx';

export async function generateMetadata() {
  const t = await getTranslations();
  return { title: t('wallet.queue.title') };
}

export default async function CreditRequestsPage({
  searchParams,
}: {
  readonly searchParams: Promise<{ readonly status?: string | readonly string[] }>;
}) {
  const { status } = await searchParams;
  const t = await getTranslations();
  const tab: QueueTab = QUEUE_TABS.find((entry) => entry === status) ?? 'pending';
  return (
    <WalletPage
      activeId="wallet-requests"
      title={t('wallet.queue.title')}
      intro={t('wallet.queue.intro')}
      anyOf={[CREDIT_VIEW]}
      stepUpNote
      body={(session, keys) => (
        <>
          <Tabs
            label={t('wallet.queue.tabs')}
            activeId={tab}
            items={QUEUE_TABS.map((id) => ({
              id,
              label: t(`wallet.queue.tab.${id}`),
              href:
                id === 'pending'
                  ? '/wallet/credit-requests'
                  : `/wallet/credit-requests?status=${id}`,
            }))}
          />
          <RequestsQueue
            // A tab is a fresh list: its own rows, cursor and open dialogs.
            key={tab}
            tab={tab}
            canApprove={keys.has(CREDIT_APPROVE)}
            accountId={session.accountId}
            csrfToken={session.csrfToken}
          />
        </>
      )}
    />
  );
}
