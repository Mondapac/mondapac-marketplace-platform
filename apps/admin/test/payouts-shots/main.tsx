import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { PayoutsList } from '../../src/payouts/payouts-list.tsx';
import { StepUpProvider } from '../../src/step-up/step-up.tsx';

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>
      <main className="mx-auto max-w-7xl p-4 md:p-6">
        <h1 className="mb-2 text-2xl font-semibold">{messages.payouts.title}</h1>
        <PayoutsList
          paging="pages"
          accountId="shots"
          marketId="AU"
          zone="Australia/Brisbane"
          csrfToken="c"
          initialView="all"
        />
      </main>
    </StepUpProvider>
  </NextIntlClientProvider>,
);
