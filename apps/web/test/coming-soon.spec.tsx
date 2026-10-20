// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { Metadata } from 'next';
import { createTranslator, NextIntlClientProvider } from 'next-intl';
import type { ReactElement, ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import messages from '../messages/en.json';
import { COMING_SOON } from '../src/shell/coming-soon.tsx';
import { StoreShell } from '../src/shell/store-shell.tsx';
import { SAMPLE_CART_SOURCE, SAMPLE_CHECKOUT } from '../src/storefront/sample-cart.ts';
import { SAMPLE_DELIVERY_LOCATOR } from '../src/storefront/sample-delivery.ts';
import { SAMPLE_CONTENT } from '../src/storefront/sample-home.ts';

vi.mock('next/navigation', () => ({
  usePathname: () => '/offers',
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));
vi.mock('next-intl/server', () => ({
  getTranslations: (namespace: string) =>
    Promise.resolve(createTranslator({ locale: 'en', messages, namespace: namespace as 'store' })),
}));

beforeEach(() => {
  window.matchMedia = (() => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

// jsdom gives import.meta.url an http scheme, so paths start from the package root.
const APP = join(process.cwd(), 'app');
const SHELL = join(process.cwd(), 'src', 'shell');

interface RouteModule {
  readonly default: () => ReactNode;
  readonly generateMetadata: () => Promise<Metadata>;
}

const PAGES = import.meta.glob<RouteModule>('../app/**/page.tsx');

/** Every page or route handler under app/, as path segments with route groups dropped. */
function appRoutes(dir = APP): string[][] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return appRoutes(path);
    if (entry.name !== 'page.tsx' && entry.name !== 'route.ts') return [];
    return [
      relative(APP, dir)
        .split(sep)
        .filter((segment) => segment !== '' && !/^\(.*\)$/.test(segment)),
    ];
  });
}

function routeExists(href: string, routes: string[][]): boolean {
  const parts = href.split(/[?#]/)[0]!.split('/').filter(Boolean);
  return routes.some((route) => {
    const optionalRest = route.at(-1)?.startsWith('[[...');
    const rest = route.at(-1)?.startsWith('[...') || optionalRest;
    const fixed = rest ? route.slice(0, -1) : route;
    if (parts.length < fixed.length || (!rest && parts.length !== fixed.length)) return false;
    if (rest && !optionalRest && parts.length === fixed.length) return false;
    return fixed.every((segment, i) => segment.startsWith('[') || segment === parts[i]);
  });
}

describe('coming soon pages', () => {
  it.each(Object.entries(COMING_SOON))(
    '%s renders its name and is kept out of the index',
    async (route, page) => {
      const load = PAGES[`../app${route}/page.tsx`];
      expect(load, `app${route}/page.tsx`).toBeDefined();
      const module = await load!();
      const metadata = await module.generateMetadata();
      const name = messages['coming-soon'].pages[page];
      expect(metadata.title).toBe(`${name} | Mondapac`);
      expect(metadata.robots).toEqual({ index: false, follow: true });

      // The page returns an async server component; jsdom renders only what it resolves to.
      const element = module.default() as ReactElement<
        { page: string },
        (props: object) => Promise<ReactNode>
      >;
      const body = await element.type(element.props);
      render(
        <NextIntlClientProvider locale="en" messages={messages} timeZone="UTC">
          <StoreShell
            content={SAMPLE_CONTENT}
            cartSource={SAMPLE_CART_SOURCE}
            locator={SAMPLE_DELIVERY_LOCATOR}
            deliverTo={null}
            consent={{ personalization: false }}
            signIn={SAMPLE_CHECKOUT.customer}
          >
            {body}
          </StoreShell>
        </NextIntlClientProvider>,
      );
      const main = screen.getByRole('main');
      expect(within(main).getByRole('heading', { level: 1 }).textContent).toBe(name);
      expect(
        within(main).getByRole('link', { name: 'Go to the home page' }).getAttribute('href'),
      ).toBe('/');
      // The Browse products page does not offer a button to itself.
      expect(within(main).queryAllByRole('button', { name: 'Browse products' })).toHaveLength(
        page === 'browse' ? 0 : 1,
      );
    },
  );

  it('has a copy entry for every route and no others', () => {
    expect(Object.keys(messages['coming-soon'].pages).sort()).toEqual(
      Object.values(COMING_SOON).sort(),
    );
  });
});

describe('shell links', () => {
  it.each(['footer.tsx', 'rail.tsx'])('every internal link in %s has a page', (file) => {
    const source = readFileSync(join(SHELL, file), 'utf8');
    const hrefs = [
      ...source.matchAll(/\[\s*'[^']+',\s*'(\/[^']*)'\s*\]/g),
      ...source.matchAll(/href[:=]\s*[{]?\s*['"`](\/[^'"`$]*)['"`]/g),
    ].map((match) => match[1]!);
    expect(hrefs.length).toBeGreaterThan(3);
    const routes = appRoutes();
    expect(hrefs.filter((href) => !routeExists(href, routes))).toEqual([]);
  });
});
