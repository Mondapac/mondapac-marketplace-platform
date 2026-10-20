import { resolveRobots } from 'next/dist/build/webpack/loaders/metadata/resolve-route-data.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

// The sample-data lock, switchable per test; the real value is true (src/storefront/source.ts).
const lock = vi.hoisted(() => ({ sampleData: true }));
vi.mock('../src/storefront/source.ts', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  get SAMPLE_DATA() {
    return lock.sampleData;
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: () => Promise.resolve((key: string) => key),
}));

const { indexingOn } = await import('../src/seo/indexing.ts');
const { proxy } = await import('../proxy.ts');
const { generateMetadata } = await import('../app/layout.tsx');
const { default: robots } = await import('../app/robots.ts');
const source = await vi.importActual<{ SAMPLE_DATA: boolean }>('../src/storefront/source.ts');

function switchOn(): void {
  vi.stubEnv('STOREFRONT_INDEXING', 'on');
  lock.sampleData = false;
}

afterEach(() => {
  vi.unstubAllEnvs();
  lock.sampleData = true;
});

describe('indexing switch', () => {
  it('ships with the sample-data lock closed', () => {
    expect(source.SAMPLE_DATA).toBe(true);
  });

  it('is off without the env', () => {
    vi.stubEnv('STOREFRONT_INDEXING', undefined);
    lock.sampleData = false;
    expect(indexingOn()).toBe(false);
  });

  it.each(['off', 'ON', 'yes', 'true', '1', '', ' on'])('is off for %j', (value) => {
    vi.stubEnv('STOREFRONT_INDEXING', value);
    lock.sampleData = false;
    expect(indexingOn()).toBe(false);
  });

  it('stays off with `on` while the storefront runs on sample data', () => {
    vi.stubEnv('STOREFRONT_INDEXING', 'on');
    expect(indexingOn()).toBe(false);
  });

  it('is on with `on` once sample data is gone', () => {
    switchOn();
    expect(indexingOn()).toBe(true);
  });
});

describe('noindex header', () => {
  it('covers every path: the proxy has no matcher', async () => {
    expect(await import('../proxy.ts')).not.toHaveProperty('config');
  });

  it('is set while off', () => {
    expect(proxy().headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('is set while the env says `on` but sample data is still in place', () => {
    vi.stubEnv('STOREFRONT_INDEXING', 'on');
    expect(proxy().headers.get('X-Robots-Tag')).toBe('noindex, nofollow');
  });

  it('is absent while on', () => {
    switchOn();
    expect(proxy().headers.has('X-Robots-Tag')).toBe(false);
  });
});

describe('root metadata', () => {
  it('says noindex, nofollow while off', async () => {
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: false });
  });

  it('sets no robots rule while on', async () => {
    switchOn();
    expect((await generateMetadata()).robots).toBeUndefined();
  });
});

describe('robots.txt', () => {
  // The text Next serves for app/robots.ts.
  const body = (): string => resolveRobots(robots());

  it('allows everything, with no sitemap, while off', () => {
    expect(body()).toBe('User-Agent: *\nAllow: /\n\n');
  });

  it.each(['off', 'on'])('never disallows the whole site while %s', (state) => {
    if (state === 'on') switchOn();
    expect(body()).not.toMatch(/^Disallow: \/$/m);
  });
});
