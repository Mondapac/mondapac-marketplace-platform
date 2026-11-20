import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { AccountsList } from '../../src/payments/accounts-list.tsx';

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-2 text-2xl font-semibold">{messages.payments.accounts.title}</h1>
      <AccountsList paging="pages" accountId="shots" marketId="AU" zone="Australia/Brisbane" />
    </main>
  </NextIntlClientProvider>,
);
