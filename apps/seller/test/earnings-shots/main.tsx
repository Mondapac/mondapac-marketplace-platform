import { Toaster } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { PayoutsList } from '../../src/earnings/list/payouts-list.tsx';
import { emptyPage, first } from './api-stub.ts';

const state = new URLSearchParams(globalThis.location.search).get('state');

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" timeZone="Australia/Melbourne" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">{messages.earnings.title}</h1>
      <h2 className="mb-3 text-lg font-semibold">{messages.payouts.history.title}</h2>
      <PayoutsList
        initial={state === 'error' ? null : state === 'empty' ? emptyPage : first}
        paging="pages"
        zone="Australia/Brisbane"
        currency="AUD"
        accountId="shots"
        marketId="AU"
      />
    </main>
    <Toaster labels={{ region: 'Action notifications', close: 'Close notification' }} />
  </NextIntlClientProvider>,
);
