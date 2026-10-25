import { describe, expect, it } from 'vitest';
import type { ApiRead } from '../src/storefront/api.ts';
import { loadSlides, slidesPath } from '../src/storefront/slides-source.ts';

const ID = '0b5e1c3a-0000-4000-8000-000000000001';
const SLIDE = {
  id: 'a',
  kind: 'promotion',
  title: 'Fresh this week',
  body: null,
  ctaLabel: null,
  image: null,
  textPosition: 'start',
  textTone: 'light',
  href: null,
  sponsored: false,
};

const reader = (answer: ApiRead<unknown>) => {
  const paths: string[] = [];
  return {
    paths,
    read: (path: string) => {
      paths.push(path);
      return Promise.resolve(answer);
    },
  };
};

describe('slides source', () => {
  it('builds the path of a position and the page it is asked for', () => {
    expect(slidesPath('home.hero')).toBe('storefront/slides?position=home.hero');
    expect(slidesPath('category.top', { category: ID.toUpperCase() })).toBe(
      `storefront/slides?position=category.top&category=${ID}`,
    );
    expect(slidesPath('no.such.position')).toBeNull();
    expect(slidesPath('category.top', { category: 'x&position=home.hero' })).toBeNull();
  });

  it('reads no API for a position or id it does not know', async () => {
    const { read, paths } = reader({ kind: 'off' });
    expect((await loadSlides('nope', {}, read, {})).slides).toEqual([]);
    expect((await loadSlides('home.mid', { product: 'x' }, read, {})).slides).toEqual([]);
    expect(paths).toEqual([]);
  });

  it('answers the sample hero while API_BASE_URL is empty, and nothing for other positions', async () => {
    const { read } = reader({ kind: 'off' });
    expect((await loadSlides('home.hero', {}, read, {})).slides.length).toBeGreaterThan(1);
    expect((await loadSlides('home.mid', {}, read, {})).slides).toEqual([]);
  });

  it('answers the checked slides of the API', async () => {
    const { read } = reader({
      kind: 'ok',
      body: {
        position: 'home.mid',
        autoplay: false,
        slides: [SLIDE, { ...SLIDE, id: 'b', href: 'https://evil.test' }],
      },
    });
    const set = await loadSlides('home.mid', {}, read, {});
    expect(set.slides.map((s) => s.id)).toEqual(['a']);
  });

  it('answers no slides, and shows no section, when the API has none live', async () => {
    const { read } = reader({ kind: 'ok', body: { position: 'home.hero', slides: [] } });
    expect((await loadSlides('home.hero', {}, read, {})).slides).toEqual([]);
  });

  it('uses the sample when the read fails, unless the fallback is off', async () => {
    const { read } = reader({ kind: 'failed', status: 503 });
    expect((await loadSlides('home.hero', {}, read, {})).slides.length).toBeGreaterThan(1);
    expect(
      (await loadSlides('home.hero', {}, read, { STOREFRONT_SAMPLE_DATA: 'off' })).slides,
    ).toEqual([]);
  });
});
