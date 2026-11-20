import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { CreditRequestsList } from '../../src/wallet/credit-requests-list.tsx';

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-2 text-2xl font-semibold">{messages.wallet.list.title}</h1>
      <CreditRequestsList
        paging="pages"
        accountId="0190a000-0000-7000-8000-0000000000a1"
        csrfToken="shots"
        marketId="AU"
        zone="Australia/Brisbane"
        initialView="all"
      />
    </main>
  </NextIntlClientProvider>,
);
