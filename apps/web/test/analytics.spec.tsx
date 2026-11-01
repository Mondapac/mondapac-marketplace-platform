// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ga4, GA4_SCRIPT_ID } from '../src/analytics/ga4.tsx';
import { ga4IdFor, parseGa4Ids } from '../src/analytics/ga4-config.ts';
import { reportedPath, reportedReferrer, reportedTitle } from '../src/analytics/page-path.ts';
import { nonceOf } from '../src/security/nonce.ts';
import { storefrontCsp } from '../src/security/storefront-csp.ts';

const nav = vi.hoisted(() => ({ pathname: '/', search: '' }));
vi.mock('next/navigation', () => ({
  usePathname: () => nav.pathname,
  useSearchParams: () => new URLSearchParams(nav.search),
}));
const vitals = vi.hoisted(() => ({ report: undefined as undefined | ((metric: unknown) => void) }));
vi.mock('next/web-vitals', () => ({
  useReportWebVitals: (report: (metric: unknown) => void) => {
    vitals.report = report;
  },
}));

const ENV = {
  STOREFRONT_HOSTS: 'http://storefront.localhost:3003=AU,http://nz.localhost:3003=NZ',
  STOREFRONT_GA4_IDS: 'AU=G-ABC123XYZ9',
};

describe('measurement ID of a Market', () => {
  it('is the ID of the Market the host belongs to', () => {
    expect(ga4IdFor('storefront.localhost:3003', ENV)).toBe('G-ABC123XYZ9');
  });

  it('is off without an ID, for a Market with none, an unlisted host or a missing host list', () => {
    expect(
      ga4IdFor('storefront.localhost:3003', { ...ENV, STOREFRONT_GA4_IDS: undefined }),
    ).toBeNull();
    expect(ga4IdFor('nz.localhost:3003', ENV)).toBeNull();
    expect(ga4IdFor('unknown.example', ENV)).toBeNull();
    expect(ga4IdFor(null, ENV)).toBeNull();
    expect(
      ga4IdFor('storefront.localhost:3003', { ...ENV, STOREFRONT_HOSTS: undefined }),
    ).toBeNull();
  });

  it('is off for an invalid ID, and says so once in the log', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    for (const bad of [
      'AU=UA-12345',
      'AU=g-abc123xyz9',
      'AU=G-AB',
      'AU=G-ABC123XYZ9999',
      'G-ABC123XYZ9',
      'AU=',
    ]) {
      expect(ga4IdFor('storefront.localhost:3003', { ...ENV, STOREFRONT_GA4_IDS: bad })).toBeNull();
    }
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('keeps the valid pairs when another is invalid', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect([...parseGa4Ids('AU=G-ABC123XYZ9, NZ=nope ,US=G-ZZZZZZ')]).toEqual([
      ['AU', 'G-ABC123XYZ9'],
      ['US', 'G-ZZZZZZ'],
    ]);
  });
});

describe('Content-Security-Policy', () => {
  it('adds the Google hosts only with a measurement ID', () => {
    const off = storefrontCsp('n', false, null);
    expect(off).not.toMatch(/google/);
    expect(storefrontCsp('n', false, null, false)).toBe(off);
    const on = storefrontCsp('n', false, null, true);
    const directive = (policy: string, name: string) =>
      policy.split('; ').find((part) => part.startsWith(`${name} `)) ?? '';
    expect(directive(on, 'connect-src')).toContain(
      'https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com',
    );
    expect(directive(on, 'img-src')).toContain(
      'https://*.google-analytics.com https://www.googletagmanager.com',
    );
    // The nonce and 'strict-dynamic' cover the loader: script-src is the same with and without.
    expect(directive(on, 'script-src')).toBe(directive(off, 'script-src'));
    expect(directive(on, 'frame-src')).toBe(directive(off, 'frame-src'));
  });

  it('gives the layout the nonce of the request', () => {
    const policy = storefrontCsp('abc+/123==', false, null);
    expect(nonceOf(policy)).toBe('abc+/123==');
    expect(nonceOf(null)).toBeNull();
  });
});

describe('reported page path', () => {
  it('keeps the query string on public pages', () => {
    expect(reportedPath('/browse', '?sort=price')).toBe('/browse?sort=price');
    expect(reportedPath('/browse', '')).toBe('/browse');
  });

  it.each(['/search', '/cart', '/account', '/account/orders/1', '/checkout', '/checkout/payment'])(
    'drops it on %s',
    (path) => {
      expect(reportedPath(path, '?q=halal+lamb&email=a%40b.c')).toBe(path);
    },
  );

  it('does not treat a lookalike path as sensitive', () => {
    expect(reportedPath('/searches', '?a=1')).toBe('/searches?a=1');
    expect(reportedPath('/cartoons', '?a=1')).toBe('/cartoons?a=1');
  });
});

function layer(): unknown[][] {
  return (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
}
const scriptTag = () => document.getElementById(GA4_SCRIPT_ID) as HTMLScriptElement | null;

describe('GA4 tag', () => {
  const reload = vi.fn();
  beforeEach(() => {
    nav.pathname = '/';
    nav.search = '';
    reload.mockReset();
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { origin: 'https://shop.example', reload },
    });
  });
  afterEach(() => {
    cleanup();
    scriptTag()?.remove();
    delete window.dataLayer;
    vitals.report = undefined;
  });

  it('loads nothing before consent: no script, no dataLayer', () => {
    render(<Ga4 id="G-ABC123XYZ9" nonce="n1" enabled={false} />);
    expect(scriptTag()).toBeNull();
    expect(window.dataLayer).toBeUndefined();
    expect(reload).not.toHaveBeenCalled();
  });

  it('loads the tag with the nonce after Accept', () => {
    render(<Ga4 id="G-ABC123XYZ9" nonce="n1" enabled />);
    const script = scriptTag()!;
    expect(script.src).toBe('https://www.googletagmanager.com/gtag/js?id=G-ABC123XYZ9');
    expect(script.getAttribute('nonce')).toBe('n1');
    expect(script.async).toBe(true);
  });

  it('denies all four types first, grants only analytics, and configures without a page view', () => {
    render(<Ga4 id="G-ABC123XYZ9" nonce="n1" enabled />);
    const commands = layer();
    const denied = {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    };
    expect(commands[0]).toEqual(['consent', 'default', denied]);
    expect(commands[2]).toEqual(['consent', 'update', { ...denied, analytics_storage: 'granted' }]);
    const config = commands.findIndex((command) => command[0] === 'config');
    expect(config).toBeGreaterThan(2);
    expect(commands[config]?.[1]).toBe('G-ABC123XYZ9');
    expect(commands[config]?.[2]).toMatchObject({ send_page_view: false, cookie_domain: 'none' });
  });

  it('sends a page view on each navigation, without the query on sensitive routes', () => {
    nav.pathname = '/browse';
    nav.search = 'sort=price';
    const view = render(<Ga4 id="G-ABC123XYZ9" nonce={null} enabled />);
    const views = () =>
      layer()
        .filter((command) => command[1] === 'page_view')
        .map((c) => c[2]);
    expect(views()).toEqual([
      expect.objectContaining({
        page_path: '/browse?sort=price',
        page_location: 'https://shop.example/browse?sort=price',
      }),
    ]);
    for (const [pathname, search] of [
      ['/search', 'q=lamb'],
      ['/account/orders', 'email=a%40b.c'],
      ['/checkout/payment', 'token=x'],
      ['/cart', 'promo=1'],
    ] as const) {
      nav.pathname = pathname;
      nav.search = search;
      view.rerender(<Ga4 id="G-ABC123XYZ9" nonce={null} enabled />);
    }
    expect(views().map((v) => (v as { page_path: string }).page_path)).toEqual([
      '/browse?sort=price',
      '/search',
      '/account/orders',
      '/checkout/payment',
      '/cart',
    ]);
    expect(JSON.stringify(layer())).not.toMatch(/lamb|email|token|promo/);
  });

  it('reports no search words in the title or the referrer', () => {
    document.title = 'Results for “halal lamb” | Mondapac';
    Object.defineProperty(document, 'referrer', {
      configurable: true,
      value: 'https://shop.example/search?q=halal+lamb',
    });
    nav.pathname = '/search';
    nav.search = 'q=halal+lamb';
    const view = render(<Ga4 id="G-ABC123XYZ9" nonce={null} enabled />);
    nav.pathname = '/browse';
    nav.search = '';
    document.title = 'Browse | Mondapac';
    view.rerender(<Ga4 id="G-ABC123XYZ9" nonce={null} enabled />);
    const views = layer()
      .filter((command) => command[1] === 'page_view')
      .map((command) => command[2]);
    expect(views[0]).toMatchObject({
      page_title: '/search',
      page_referrer: 'https://shop.example/search',
    });
    expect(views[1]).toMatchObject({
      page_title: 'Browse | Mondapac',
      page_referrer: 'https://shop.example/search',
    });
    expect(JSON.stringify(layer())).not.toMatch(/lamb/i);
  });

  it('keeps only the origin of a referrer from another site', () => {
    expect(reportedReferrer('https://www.google.com/search?q=halal', 'https://shop.example')).toBe(
      'https://www.google.com',
    );
    expect(reportedReferrer('', 'https://shop.example')).toBe('');
    expect(reportedTitle('/account/orders', 'Order 123 for Jo')).toBe('/account/orders');
  });

  it('sends LCP, INP and CLS as events, and ignores other metrics', () => {
    nav.pathname = '/search';
    nav.search = 'q=lamb';
    render(<Ga4 id="G-ABC123XYZ9" nonce={null} enabled />);
    const send = (name: string, value: number) =>
      act(() => vitals.report?.({ name, value, id: `${name}-1`, delta: value, rating: 'good' }));
    send('LCP', 1234.4);
    send('INP', 80);
    send('CLS', 0.0456);
    send('TTFB', 300);
    const events = layer().filter(
      (command) => command[0] === 'event' && command[1] !== 'page_view',
    );
    expect(events.map((event) => event[1])).toEqual(['LCP', 'INP', 'CLS']);
    expect(events[0]?.[2]).toMatchObject({
      value: 1234,
      page_path: '/search',
      non_interaction: true,
    });
    expect(events[2]?.[2]).toMatchObject({ value: 46, metric_value: 0.0456 });
    expect(JSON.stringify(events)).not.toContain('lamb');
  });

  it('reloads the page once when consent is withdrawn, and loads nothing new', () => {
    const view = render(<Ga4 id="G-ABC123XYZ9" nonce="n1" enabled />);
    expect(reload).not.toHaveBeenCalled();
    view.rerender(<Ga4 id="G-ABC123XYZ9" nonce="n1" enabled={false} />);
    expect(reload).toHaveBeenCalledTimes(1);
    view.rerender(<Ga4 id="G-ABC123XYZ9" nonce="n1" enabled={false} />);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('loads the tag when consent is given later on the same page', () => {
    const view = render(<Ga4 id="G-ABC123XYZ9" nonce="n1" enabled={false} />);
    expect(scriptTag()).toBeNull();
    view.rerender(<Ga4 id="G-ABC123XYZ9" nonce="n1" enabled />);
    expect(scriptTag()).not.toBeNull();
    expect(reload).not.toHaveBeenCalled();
  });
});

describe('proxy', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('adds the Google hosts to the policy only for a host whose Market has an ID', async () => {
    const { NextRequest } = await import('next/server');
    const { proxy } = await import('../proxy.ts');
    vi.stubEnv('STOREFRONT_HOSTS', ENV.STOREFRONT_HOSTS);
    vi.stubEnv('STOREFRONT_GA4_IDS', ENV.STOREFRONT_GA4_IDS);
    const policy = (host: string) =>
      proxy(new NextRequest(`http://${host}/`, { headers: { host } })).headers.get(
        'Content-Security-Policy',
      );
    expect(policy('storefront.localhost:3003')).toContain('https://www.googletagmanager.com');
    expect(policy('nz.localhost:3003')).not.toMatch(/google/);
    vi.stubEnv('STOREFRONT_GA4_IDS', '');
    expect(policy('storefront.localhost:3003')).not.toMatch(/google/);
  });
});
