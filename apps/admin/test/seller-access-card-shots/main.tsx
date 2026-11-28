import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { SellerAccessCard } from '../../src/sellers/seller-access-card.tsx';

const scenario = new URLSearchParams(window.location.search).get('s') ?? 'approved';
const SELLER = '0190a000-0000-7000-8000-000000000001';
window.fetch = () =>
  Promise.resolve(
    new Response(JSON.stringify({ code: 'seller-access.wrong-state' }), { status: 409 }),
  );
const access = scenario.startsWith('suspended') ? 'suspended' : 'approved';
createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="bg-canvas p-4 text-fg sm:p-8">
      <SellerAccessCard sellerId={SELLER} access={access} csrfToken="csrf" />
    </main>
  </NextIntlClientProvider>,
);
