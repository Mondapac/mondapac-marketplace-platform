import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { LedgerCard } from '../../src/commission/ledger-card.tsx';
import { PayoutHoldsCard } from '../../src/payouts/holds-card.tsx';
import { StepUpProvider } from '../../src/step-up/step-up.tsx';

const SELLER = '0190a000-0000-7000-8000-0000000000c1';
const TOTALS = {
  sales: '1284500',
  shipping: '96200',
  commission: '192675',
  refundedSales: '45000',
  refundedShipping: '4000',
  refundedCommission: '6750',
  disputeDebits: '15000',
  disputeReinstated: '0',
  sellerCashback: '2500',
  balance: '1021275',
};

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>
      <main className="mx-auto flex max-w-7xl flex-col gap-6 p-4 md:p-6">
        <h1 className="text-2xl font-semibold">Seller review</h1>
        <PayoutHoldsCard
          sellerId={SELLER}
          paging="pages"
          accountId="0190a000-0000-7000-8000-0000000000a1"
          marketId="AU"
          zone="Australia/Brisbane"
          canPlace
          csrfToken="shots"
        />
        <LedgerCard
          sellerId={SELLER}
          currency="AUD"
          initialTotals={TOTALS}
          paging="pages"
          accountId="0190a000-0000-7000-8000-0000000000a1"
          marketId="AU"
          zone="Australia/Brisbane"
        />
      </main>
    </StepUpProvider>
  </NextIntlClientProvider>,
);
