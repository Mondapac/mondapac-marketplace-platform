import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import { Toaster } from '@mondapac/ui';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { ModerationList } from '../../src/reviews/moderation-list/moderation-list.tsx';
import { StepUpProvider } from '../../src/step-up/step-up.tsx';

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages} timeZone="Australia/Brisbane">
    <StepUpProvider>
      <main className="mx-auto max-w-7xl p-4 md:p-6">
        <h1 className="mb-4 text-2xl font-semibold">{messages['reviews-moderation'].title}</h1>
        <ModerationList
          paging="pages"
          accountId="acc-1"
          marketId="AU"
          zone="Australia/Brisbane"
          canModerate
          canRemove
          csrfToken="csrf"
        />
      </main>
    </StepUpProvider>
    <Toaster labels={{ region: messages.toast.region, close: messages.toast.close }} />
  </NextIntlClientProvider>,
);
