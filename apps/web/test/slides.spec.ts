import { describe, expect, it } from 'vitest';
import {
  emptySet,
  imageSrcOf,
  legacySlideOf,
  plainText,
  sitePath,
  slideOf,
  slideSetOf,
} from '../src/storefront/slides.ts';

// The buyer site re-checks every slide the API answers: plain text, site-path links, images from
// this app or our own media origin only. A slide that fails is dropped on its own.

const MEDIA = 'https://media.example.test';

const slide = (over: Record<string, unknown> = {}) => ({
  id: '01990000-0000-7000-8000-000000001001',
  kind: 'promotion',
  title: 'Fresh this week',
  body: 'Halal lamb and chicken',
  ctaLabel: 'Shop now',
  image: { key: 'fruits', alt: 'Fruit', decorative: false },
  textPosition: 'start',
  textTone: 'dark',
  href: '/offers',
  sponsored: false,
  ...over,
});

const answer = (slides: unknown[], over: Record<string, unknown> = {}) => ({
  position: 'home.hero',
  autoplay: true,
  slides,
  nextChangeAt: null,
  ...over,
});

describe('plain text', () => {
  it('keeps text, Persian included, and trims it', () => {
    expect(plainText('  Fresh & halal  ', 60)).toBe('Fresh & halal');
    expect(plainText('گوشت تازه و حلال', 60)).toBe('گوشت تازه و حلال');
  });

  it.each([
    ['markup', '<b>Sale</b>'],
    ['an angle bracket', 'a > b'],
    ['a URL', 'visit https://evil.test'],
    ['a www address', 'see www.evil.test'],
    ['a javascript scheme', 'javascript:alert(1)'],
    ['a control character', 'a\u0007b'],
    ['nothing', '   '],
    ['too many characters', 'x'.repeat(61)],
  ])('refuses %s', (_name, value) => {
    expect(plainText(value, 60)).toBeUndefined();
  });

  it('counts characters, not code units', () => {
    expect(plainText('😀'.repeat(60), 60)).toBeDefined();
    expect(plainText('😀'.repeat(61), 60)).toBeUndefined();
  });
});

describe('site paths', () => {
  it.each([
    '/',
    '/offers',
    '/c/meat/lamb',
    '/p/0b5e1c3a-0000-4000-8000-000000000003',
    '/s/halal-hub',
    '/search?q=lamb',
  ])('accepts %s', (path) => {
    expect(sitePath(path)).toBe(path);
  });

  it.each([
    'https://example.com/a',
    'http://example.com',
    '//evil.test',
    '/\\evil.test',
    'offers',
    'javascript:alert(1)',
    '/a/../b',
    '/a b',
    '/a#b',
    `/${'a'.repeat(200)}`,
    '',
  ])('refuses %j', (path) => {
    expect(sitePath(path)).toBeUndefined();
  });
});

describe('images', () => {
  it('maps a ready-made key to our own path and refuses an unknown key', () => {
    expect(imageSrcOf({ key: 'bread' }, null)).toBe('/placeholders/bread.jpg');
    expect(imageSrcOf({ key: 'unknown' }, null)).toBeUndefined();
    expect(imageSrcOf({ key: '../x' }, null)).toBeUndefined();
  });

  it('accepts a URL only on the media origin, with a plain path', () => {
    expect(imageSrcOf({ url: `${MEDIA}/slides/a1.webp` }, MEDIA)).toBe(`${MEDIA}/slides/a1.webp`);
    expect(imageSrcOf({ url: `${MEDIA}/slides/a1.webp` }, null)).toBeUndefined();
    expect(imageSrcOf({ url: 'https://evil.test/a.webp' }, MEDIA)).toBeUndefined();
    expect(imageSrcOf({ url: `${MEDIA}/a.webp?x=1` }, MEDIA)).toBeUndefined();
    expect(imageSrcOf({ url: `https://u:p@media.example.test/a.webp` }, MEDIA)).toBeUndefined();
    expect(imageSrcOf({ url: `${MEDIA}.evil.test/a.webp` }, MEDIA)).toBeUndefined();
    expect(imageSrcOf({ url: 'data:image/png;base64,AAAA' }, MEDIA)).toBeUndefined();
    expect(imageSrcOf({ url: 'javascript:alert(1)' }, MEDIA)).toBeUndefined();
  });
});

describe('one slide', () => {
  it('becomes a slide with its fields', () => {
    expect(slideOf(slide(), null)).toEqual({
      id: '01990000-0000-7000-8000-000000001001',
      title: 'Fresh this week',
      body: 'Halal lamb and chicken',
      ctaLabel: 'Shop now',
      href: '/offers',
      image: { src: '/placeholders/fruits.jpg', alt: 'Fruit', decorative: false },
      placement: 'start',
      tone: 'dark',
      sponsored: false,
    });
  });

  it('needs only a title, the placement and the tone', () => {
    expect(slideOf(slide({ body: null, ctaLabel: null, image: null, href: null }), null)).toEqual({
      id: '01990000-0000-7000-8000-000000001001',
      title: 'Fresh this week',
      placement: 'start',
      tone: 'dark',
      sponsored: false,
    });
  });

  it.each([
    ['markup in the title', { title: '<img src=x onerror=alert(1)>' }],
    ['a URL in the body', { body: 'go to https://evil.test' }],
    ['an external link', { href: 'https://evil.test' }],
    ['a protocol-relative link', { href: '//evil.test' }],
    ['a javascript link', { href: 'javascript:alert(1)' }],
    ['a button with nothing to open', { href: null }],
    ['a button label with markup', { ctaLabel: '<b>go</b>' }],
    ['an unknown image key', { image: { key: 'nope', alt: 'x', decorative: false } }],
    [
      'an image URL from another host',
      { image: { url: 'https://evil.test/a.png', alt: 'x', decorative: false } },
    ],
    ['a content image with no alt text', { image: { key: 'fruits', alt: '', decorative: false } }],
    ['a decorative image with alt text', { image: { key: 'fruits', alt: 'x', decorative: true } }],
    ['markup in the alt text', { image: { key: 'fruits', alt: '<x>', decorative: false } }],
    ['an unknown placement', { textPosition: 'left' }],
    ['an unknown tone', { textTone: 'blue' }],
    ['no sponsored flag', { sponsored: undefined }],
    ['an id with a slash', { id: 'a/b' }],
    ['no id', { id: undefined }],
    ['a long title', { title: 'x'.repeat(61) }],
    ['a long button label', { ctaLabel: 'x'.repeat(25) }],
  ])('is dropped for %s', (_name, over) => {
    expect(slideOf(slide(over), null)).toBeNull();
  });

  it('keeps a decorative image with no alt text', () => {
    expect(
      slideOf(slide({ image: { key: 'fruits', alt: '', decorative: true } }), null)?.image,
    ).toEqual({ src: '/placeholders/fruits.jpg', alt: '', decorative: true });
  });

  it('is dropped when it is not an object', () => {
    for (const bad of [null, 'x', 4, [], undefined]) expect(slideOf(bad, null)).toBeNull();
  });
});

describe('the answer for a position', () => {
  it('keeps the valid slides in order and drops the others on their own', () => {
    const set = slideSetOf(
      answer([
        slide({ id: 'a' }),
        slide({ id: 'b', href: 'https://evil.test' }),
        slide({ id: 'c', title: 'Third' }),
      ]),
      'home.hero',
      null,
    );
    expect(set.slides.map((s) => s.id)).toEqual(['a', 'c']);
    expect(set.autoplay).toBe(true);
  });

  it('drops a repeated id and stops at the most the position shows', () => {
    const many = Array.from({ length: 12 }, (_, i) => slide({ id: `s${i}` }));
    expect(
      slideSetOf(answer([slide({ id: 'a' }), slide({ id: 'a' })]), 'home.hero', null).slides,
    ).toHaveLength(1);
    expect(slideSetOf(answer(many), 'home.hero', null).slides).toHaveLength(8);
    expect(
      slideSetOf(answer(many, { position: 'home.mid' }), 'home.mid', null).slides,
    ).toHaveLength(4);
  });

  it('allows autoplay only at a position that may autoplay and with more than one slide', () => {
    expect(slideSetOf(answer([slide({ id: 'a' })]), 'home.hero', null).autoplay).toBe(false);
    const two = [slide({ id: 'a' }), slide({ id: 'b' })];
    expect(slideSetOf(answer(two, { position: 'home.mid' }), 'home.mid', null).autoplay).toBe(
      false,
    );
    expect(slideSetOf(answer(two, { position: 'landing.top' }), 'landing.top', null).autoplay).toBe(
      true,
    );
    expect(slideSetOf(answer(two, { autoplay: false }), 'home.hero', null).autoplay).toBe(false);
    expect(slideSetOf(answer(two, { autoplay: 'yes' }), 'home.hero', null).autoplay).toBe(false);
  });

  it('is no slides when the answer is for another position or not the expected shape', () => {
    expect(slideSetOf(answer([slide()], { position: 'home.mid' }), 'home.hero', null)).toEqual(
      emptySet('home.hero'),
    );
    expect(slideSetOf(answer([slide()]), 'no.such.position', null).slides).toEqual([]);
    expect(slideSetOf({ position: 'home.hero', slides: 'x' }, 'home.hero', null).slides).toEqual(
      [],
    );
    expect(slideSetOf(null, 'home.hero', null).slides).toEqual([]);
    expect(slideSetOf([], 'home.hero', null).slides).toEqual([]);
  });

  it('reads an image on the media origin and nowhere else', () => {
    const on = slide({
      id: 'a',
      image: { url: `${MEDIA}/s/a.webp`, alt: 'Lamb', decorative: false },
    });
    expect(slideSetOf(answer([on]), 'home.hero', MEDIA).slides[0]?.image?.src).toBe(
      `${MEDIA}/s/a.webp`,
    );
    expect(slideSetOf(answer([on]), 'home.hero', null).slides).toEqual([]);
  });
});

describe('the old top banner as a slide', () => {
  it('keeps the title, text, link, button and ready-made image', () => {
    expect(
      legacySlideOf(
        {
          title: 'Ramadan specials',
          subtitle: 'Dates, lamb and sweets',
          href: '/offers',
          ctaLabel: 'Shop now',
          image: { ref: 'fruits', alt: 'Fruit' },
        },
        'b1',
      ),
    ).toEqual({
      id: 'b1',
      title: 'Ramadan specials',
      body: 'Dates, lamb and sweets',
      ctaLabel: 'Shop now',
      href: '/offers',
      image: { src: '/placeholders/fruits.jpg', alt: 'Fruit', decorative: false },
      placement: 'start',
      tone: 'dark',
      sponsored: false,
    });
  });

  it('cuts a long title, leaves out an external link with its button and an unknown image', () => {
    const slide = legacySlideOf(
      {
        title: 'x'.repeat(80),
        href: 'https://example.com',
        ctaLabel: 'Go',
        image: { ref: 'unknown', alt: 'x' },
      },
      'b1',
    );
    expect(slide?.title).toHaveLength(60);
    expect(slide).not.toHaveProperty('href');
    expect(slide).not.toHaveProperty('ctaLabel');
    expect(slide).not.toHaveProperty('image');
  });

  it('is nothing without a title', () => {
    expect(legacySlideOf({ subtitle: 'x' }, 'b1')).toBeNull();
  });
});
