import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { DisputesList } from '../../src/disputes/disputes-list.tsx';

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-2 text-2xl font-semibold">{messages.disputes.title}</h1>
      <DisputesList
        paging="pages"
        accountId="shots"
        marketId="AU"
        zone="Australia/Brisbane"
        initialView="all"
      />
    </main>
  </NextIntlClientProvider>,
);
