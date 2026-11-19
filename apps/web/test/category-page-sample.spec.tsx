import { NextIntlClientProvider, createTranslator } from 'next-intl';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { StoreProvider } from '../src/shell/store-context.tsx';

// The category page on sample data (API off, categories C6): the filter, sort and count bar of an
// empty category, and the child chips with the sample's counts.

vi.mock('next/headers', () => ({
  headers: () => Promise.resolve(new Headers({ host: 'shop.example' })),
  cookies: () => Promise.resolve({ get: () => undefined }),
}));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('not found');
  },
  usePathname: () => '/c/meat',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(createTranslator({ locale: 'en', messages, namespace: namespace as 'store' })),
}));

const { default: CategoryPage } = await import('../app/c/[slug]/page.tsx');

const html = async (slug: string, query: Record<string, string> = {}) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
      <StoreProvider>
        {
          (await CategoryPage({
            params: Promise.resolve({ slug }),
            searchParams: Promise.resolve(query),
          })) as ReactElement
        }
      </StoreProvider>
    </NextIntlClientProvider>,
  );
const chipsOf = (page: string) => /<nav class="fchips"[\s\S]*?<\/nav>/u.exec(page)?.[0] ?? '';

describe('category page on sample data', () => {
  it('shows no filter, sort or count bar on an empty category until a filter is set', async () => {
    const empty = await html('duck-and-turkey');
    expect(empty).toContain('There are no products in Duck and turkey yet. Check back soon.');
    expect(empty).not.toContain('class="rbar"');

    const filtered = await html('duck-and-turkey', { special: '1' });
    expect(filtered).toContain('class="rbar"');
  });

  it('leaves out a child chip whose count is 0 and shows the others with theirs', async () => {
    const chips = chipsOf(await html('meat'));
    expect(chips).toContain('href="/c/beef"');
    expect(chips).not.toContain('href="/c/pork"');
    expect(chips).toMatch(/Lamb<span class="cnt num" aria-hidden="true">2<\/span>/u);
  });
});
