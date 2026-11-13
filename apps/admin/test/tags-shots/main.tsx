import { NextIntlClientProvider } from 'next-intl';
import { createRoot } from 'react-dom/client';
import messages from '../../messages/en.json';
import '../../app/globals.css';
import { TagsView } from '../../src/tags/tags-view.tsx';

const id = (n: number) => `0190a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const topic = (
  n: number,
  slug: string,
  group: string,
  name: string,
  synonyms: string[],
  status = 'active',
  other: Record<string, string> = {},
) => ({
  id: id(n),
  slug,
  group,
  status,
  names: { 'en-AU': name, ...other },
  synonyms: { 'en-AU': synonyms, ...(other['ar-AU'] ? { 'ar-AU': ['شواء'] } : {}) },
  intro: n === 1 ? 'Grills, charcoal, marinades and everything for a weekend barbecue.' : null,
  createdAt: '2026-11-01T01:00:00.000Z',
  updatedAt: '2026-11-07T01:00:00.000Z',
  version: 2,
});
const items = [
  topic(1, 'bbq', 'use', 'BBQ', ['Barbecue', 'Grill', 'Smoker', 'Braai'], 'active', {
    'ar-AU': 'باربكيو',
  }),
  topic(2, 'ramadan', 'occasion', 'Ramadan', ['Ramazan']),
  topic(3, 'persian-food', 'cuisine', 'Persian food', ['Iranian food', 'Persian cuisine']),
  topic(4, 'eid-al-fitr', 'occasion', 'Eid al-Fitr', [], 'archived'),
  topic(5, 'lunch-box', 'use', 'Lunch box', ['School lunch', 'Packed lunch', 'Bento']),
];
window.fetch = ((input: string) => {
  const path = input.replace(/^\/api\//, '').split('?')[0]!;
  const body =
    path === 'catalog/admin/topics'
      ? {
          items,
          nextAfterId: id(5),
          locales: { default: 'en-AU', supported: ['en-AU', 'ar-AU'] },
          groups: ['occasion', 'cuisine', 'use'],
          maxSynonyms: 10,
        }
      : { code: 'not-found' };
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}) as typeof fetch;

createRoot(document.getElementById('root')!).render(
  <NextIntlClientProvider locale="en-AU" messages={messages}>
    <main className="mx-auto max-w-7xl p-4 md:p-6">
      <h1 className="mb-4 text-2xl font-semibold">{messages.tags.title}</h1>
      <TagsView canManage csrfToken="tok" />
    </main>
  </NextIntlClientProvider>,
);
