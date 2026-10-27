import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const SOURCE = readFileSync(new URL('../public/sw.js', import.meta.url), 'utf8');
const ORIGIN = 'https://shop.example.test';

type Listener = (event: unknown) => void;

/** Loads public/sw.js in a sandbox with a fake cache store and network. */
function load(opts: { version?: string; online?: boolean; htmlAssets?: string[] } = {}) {
  const listeners: Record<string, Listener> = {};
  const stores = new Map<string, Map<string, Response>>();
  const fetched: { url: string; init?: RequestInit }[] = [];
  const state = { online: opts.online ?? true, type: 'basic' as ResponseType };
  const key = (r: Request | string) => new URL(typeof r === 'string' ? r : r.url, ORIGIN).pathname;
  const caches = {
    open: (name: string) => {
      if (!stores.has(name)) stores.set(name, new Map());
      const store = stores.get(name)!;
      return Promise.resolve({
        put: (r: Request | string, res: Response) => {
          store.set(key(r), res);
          return Promise.resolve();
        },
        match: (r: Request | string) => Promise.resolve(store.get(key(r))),
      });
    },
    keys: () => Promise.resolve([...stores.keys()]),
    delete: (name: string) => Promise.resolve(stores.delete(name)),
  };
  const html = `<html><script src="${(opts.htmlAssets ?? ['/_next/static/chunks/app.js'])[0]}"></script>${(
    opts.htmlAssets ?? ['/_next/static/chunks/app.js']
  )
    .map((a) => `<link href="${a}">`)
    .join('')}</html>`;
  const sandbox = {
    self: {
      location: {
        href: `${ORIGIN}/sw.js${opts.version ? `?v=${opts.version}` : ''}`,
        origin: ORIGIN,
      },
      addEventListener: (type: string, fn: Listener) => (listeners[type] = fn),
      clients: { claim: () => Promise.resolve() },
    },
    caches,
    fetch: (r: Request | string, init?: RequestInit) => {
      const url = typeof r === 'string' ? r : r.url;
      fetched.push({ url, init });
      if (!state.online) return Promise.reject(new TypeError('network down'));
      const body = key(url) === '/offline' ? html : 'file';
      const response = new Response(body, { status: 200 });
      // A same-origin fetch answers with type "basic".
      Object.defineProperty(response, 'type', { value: state.type });
      return Promise.resolve(response);
    },
    URL,
    Response,
    Request,
    Set,
    Promise,
    console,
  };
  vm.runInNewContext(SOURCE, sandbox);
  const event = (request: Request) => {
    let responded: Promise<Response> | null = null;
    listeners.fetch?.({
      request,
      respondWith: (p: Promise<Response>) => (responded = Promise.resolve(p)),
    });
    return responded as Promise<Response> | null;
  };
  const wait = async (type: 'install' | 'activate') => {
    let p: Promise<unknown> = Promise.resolve();
    listeners[type]?.({ waitUntil: (x: Promise<unknown>) => (p = x) });
    await p;
  };
  return { stores, fetched, state, event, wait };
}

const get = (path: string, init: RequestInit = {}, mode?: RequestMode) => {
  const req = new Request(`${ORIGIN}${path}`, init);
  if (mode) Object.defineProperty(req, 'mode', { value: mode });
  return req;
};
const nav = (path: string) => get(path, {}, 'navigate');

describe('service worker caching rules', () => {
  it('precaches only /offline, the static files it names and the icons, without cookies', async () => {
    const sw = load({ version: 'abc123' });
    await sw.wait('install');
    expect([...sw.stores.keys()].sort()).toEqual(['mp-web-shell-abc123', 'mp-web-static-abc123']);
    expect([...sw.stores.get('mp-web-shell-abc123')!.keys()].sort()).toEqual([
      '/icons/apple-touch-icon.png',
      '/icons/icon-192.png',
      '/icons/icon-512-maskable.png',
      '/icons/icon-512.png',
      '/offline',
    ]);
    expect([...sw.stores.get('mp-web-static-abc123')!.keys()]).toEqual([
      '/_next/static/chunks/app.js',
    ]);
    // No request of the install carries the buyer's cookies.
    expect(sw.fetched.every((f) => f.init?.credentials === 'omit')).toBe(true);
  });

  it('serves navigations network-first and the saved offline page only when the network fails', async () => {
    const sw = load();
    await sw.wait('install');
    expect(await (await sw.event(nav('/p/brisket'))!).text()).toBe('file');
    sw.state.online = false;
    const offline = await sw.event(nav('/p/brisket'))!;
    expect(await offline.text()).toContain('<html>');
    // The online page was not saved.
    expect([...sw.stores.get('mp-web-shell-v1')!.keys()]).not.toContain('/p/brisket');
  });

  it('never stores any HTML other than /offline', async () => {
    const sw = load();
    await sw.wait('install');
    for (const p of ['/', '/p/brisket', '/search?q=a', '/offline']) await sw.event(nav(p))!;
    const saved = [...sw.stores.values()].flatMap((s) => [...s.keys()]);
    expect(
      saved.filter((k) => !k.startsWith('/_next/static/') && !k.startsWith('/icons/')),
    ).toEqual(['/offline']);
  });

  it('leaves non-GET, cross-origin, API, credentialed and account/cart/checkout/payment requests alone', async () => {
    const sw = load();
    await sw.wait('install');
    const before = sw.fetched.length;
    const ignored = [
      get('/api/cart', { method: 'POST', body: '{}' }),
      get('/_next/static/a.js', { method: 'POST', body: 'x' }),
      get('/api/storefront/cart'),
      get('/api/anything/_next/static/x.js'),
      get('/account/orders'),
      get('/account'),
      get('/cart'),
      get('/checkout/payment'),
      get('/payment/return'),
      get('/_next/static/a.js', { headers: { Authorization: 'Bearer t' } }),
      new Request('https://js.stripe.com/v3/', { method: 'GET' }),
      new Request('https://cdn.example.test/_next/static/a.js'),
      get('/photos/a.jpg'),
      get('/manifest.webmanifest'),
    ];
    for (const r of ignored) expect(sw.event(r)).toBeNull();
    expect(sw.fetched.length).toBe(before);
    expect(sw.stores.size).toBe(2);
  });

  it('keeps only hashed static files, cache-first, and never an error or opaque response', async () => {
    const sw = load({ version: 'v9' });
    await sw.wait('install');
    const first = await sw.event(get('/_next/static/chunks/other.js'))!;
    expect(await first.text()).toBe('file');
    expect(sw.stores.get('mp-web-static-v9')!.has('/_next/static/chunks/other.js')).toBe(true);
    const calls = sw.fetched.length;
    await sw.event(get('/_next/static/chunks/other.js'))!;
    expect(sw.fetched.length).toBe(calls);
    sw.state.type = 'opaque';
    await sw.event(get('/_next/static/chunks/opaque.js'))!;
    expect(sw.stores.get('mp-web-static-v9')!.has('/_next/static/chunks/opaque.js')).toBe(false);
  });

  it('deletes caches of other versions on activate and keeps its own', async () => {
    const sw = load({ version: 'new' });
    await sw.wait('install');
    sw.stores.set('mp-web-shell-old', new Map());
    sw.stores.set('mp-web-static-old', new Map());
    sw.stores.set('other-app-cache', new Map());
    await sw.wait('activate');
    expect([...sw.stores.keys()].sort()).toEqual([
      'mp-web-shell-new',
      'mp-web-static-new',
      'other-app-cache',
    ]);
  });

  it('does not call skipWaiting (an update waits for the old tabs to close)', () => {
    expect(SOURCE).not.toMatch(/skipWaiting\(/);
  });

  it('falls back to a constant version when the build id is missing or malformed', async () => {
    for (const version of [undefined, '../evil', 'a b']) {
      const sw = load({ version });
      await sw.wait('install');
      expect([...sw.stores.keys()]).toContain('mp-web-shell-v1');
    }
  });
});
