import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { RequestsList } from '../../src/account-deletion/requests-list.tsx';
import { StepUpProvider } from '../../src/step-up/step-up.tsx';

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <StepUpProvider>
      <main className="mx-auto max-w-7xl p-4 md:p-6">
        <h1 className="mb-2 text-2xl font-semibold">
          {messages['account-deletion'].requests.title}
        </h1>
        <RequestsList
          paging="pages"
          accountId="0190a000-0000-7000-8000-0000000000a1"
          csrfToken="shots"
          marketId="AU"
          zone="Australia/Brisbane"
          initialView="all"
        />
      </main>
    </StepUpProvider>
  </NextIntlClientProvider>,
);
