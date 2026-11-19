import { LoadError, SettingsPage } from '@mondapac/ui';
import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import './shots.css';
import { ServiceAreaNamesPanel } from '../../src/service-area-names/service-area-names-panel.tsx';

const name = (n: string, edited = false, configuredName: string | null = n) => ({
  name: n,
  configuredName,
  edited,
});
const area = (
  code: string,
  region: string | null,
  names: Record<string, ReturnType<typeof name>>,
  actions = ['edit-names'],
) => ({
  code,
  region,
  sellerOnboardingEnabled: true,
  deliveryEnabled: true,
  actions,
  names,
});
const q = new URLSearchParams(location.search);
const state = q.get('state') ?? 'list';
const areas =
  state === 'empty'
    ? []
    : [
        area('brisbane', 'QLD', {
          en: name('Greater Brisbane'),
          fa: name('برزبین بزرگ', true, null),
          ar: name('بريزبين الكبرى'),
        }),
        area('gold-coast', 'QLD', {
          en: name('Gold Coast'),
          fa: name('گلد کوست'),
          ar: name('غولد كوست'),
        }),
        area(
          'sunshine-coast',
          'QLD',
          {
            en: name('Sunshine Coast', true, 'Sunshine Coast Region'),
            fa: name('ساحل آفتابی'),
            ar: name('ساحل الشمس'),
          },
          [],
        ),
      ];
window.fetch = () => Promise.resolve(new Response('{}', { status: 200 }));

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      {state === 'error' ? (
        <SettingsPage title={messages.serviceAreas.title}>
          <LoadError
            message={messages.serviceAreas.unavailable}
            retryLabel={messages.load.retry}
            className="flex flex-col items-start gap-3"
          />
        </SettingsPage>
      ) : (
        <ServiceAreaNamesPanel
          initial={{ defaultLanguage: 'en', languages: ['en', 'fa', 'ar'], areas }}
          csrfToken="tok"
        />
      )}
    </main>
  </NextIntlClientProvider>,
);
