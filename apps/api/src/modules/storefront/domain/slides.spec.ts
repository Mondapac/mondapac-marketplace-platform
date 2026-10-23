import { Temporal } from '@mondapac/shared-kernel';
import { TEST_MARKETS } from '../../../../test/support/test-config';
import { POSITIONS, positionOf } from './slide-positions';
import {
  capExceeded,
  MAX_WINDOW_HOURS,
  parseDraft,
  parseNewSlide,
  readContent,
  readPlacements,
  scopesMeet,
  statusOf,
  storedContent,
  storedPlacements,
  windowProblems,
  type PlacedSlide,
  type SlideKind,
} from './slides';

// The slide domain: per-kind content, the typed link, images and alt text, the positions and their
// caps, the 90-day rule, autoplay, the derived status and the max-active check. Run for both
// Market fixtures: the texts differ in language, and a window is an instant, not a local date.

const T0 = Temporal.Instant.from('2026-10-23T00:00:00Z');
const UUID_A = '01990000-0000-7000-8000-00000000000a';
const UUID_B = '01990000-0000-7000-8000-00000000000b';
const TITLES: Record<string, string> = { AU: 'Eid sale', ZZ: 'Ünïcode — 祭り' };

const problemsOf = (kind: SlideKind, body: unknown) => {
  const parsed = parseDraft(kind, body);
  return parsed.ok ? [] : parsed.problems;
};

describe.each(TEST_MARKETS)('slide domain in market %s', (code) => {
  const title = TITLES[code]!;
  const valid = (overrides: Record<string, unknown> = {}) => ({
    internalName: `Campaign ${code}`,
    content: { title },
    startsAt: T0.toString(),
    endsAt: T0.add({ hours: 24 * 30 }).toString(),
    placements: [{ position: 'home.hero' }],
    ...overrides,
  });
  const content = (overrides: Record<string, unknown>) =>
    valid({ content: { title, ...overrides } });

  describe('content', () => {
    it('accepts the three kinds and fills the defaults', () => {
      for (const kind of ['announcement', 'promotion'] as const) {
        const parsed = parseDraft(kind, valid());
        expect(parsed).toMatchObject({
          ok: true,
          value: {
            content: {
              title,
              body: null,
              ctaLabel: null,
              image: null,
              textPosition: 'start',
              textTone: 'light',
              link: null,
            },
            pinned: false,
            sponsored: false,
          },
        });
      }
      const link = { type: 'category', id: UUID_A };
      expect(parseDraft('link', content({ link })).ok).toBe(true);
    });

    it('requires a link for kind link and allows one for the other kinds', () => {
      expect(problemsOf('link', valid())).toEqual([{ path: 'content.link', code: 'required' }]);
      const link = { type: 'product', id: UUID_A };
      expect(parseDraft('announcement', content({ link })).ok).toBe(true);
      expect(parseDraft('promotion', content({ link })).ok).toBe(true);
    });

    it('holds the length caps: title 60, body 160, button label 24', () => {
      expect(parseDraft('announcement', content({ title: 'x'.repeat(60) })).ok).toBe(true);
      expect(problemsOf('announcement', content({ title: 'x'.repeat(61) }))).toEqual([
        { path: 'content.title', code: 'length' },
      ]);
      expect(parseDraft('announcement', content({ body: 'y'.repeat(160) })).ok).toBe(true);
      expect(problemsOf('announcement', content({ body: 'y'.repeat(161) }))).toEqual([
        { path: 'content.body', code: 'length' },
      ]);
      const link = { type: 'seller', id: UUID_A };
      expect(parseDraft('promotion', content({ link, ctaLabel: 'z'.repeat(24) })).ok).toBe(true);
      expect(problemsOf('promotion', content({ link, ctaLabel: 'z'.repeat(25) }))).toEqual([
        { path: 'content.ctaLabel', code: 'length' },
      ]);
    });

    it('requires a title and refuses a button label with nothing to open', () => {
      expect(problemsOf('announcement', valid({ content: {} }))).toEqual([
        { path: 'content.title', code: 'required' },
      ]);
      expect(problemsOf('announcement', content({ ctaLabel: 'Shop' }))).toEqual([
        { path: 'content.ctaLabel', code: 'needs-link' },
      ]);
    });

    it('keeps text plain: no markup, no URL, no control or format character', () => {
      for (const bad of [
        '<b>Sale</b>',
        'a > b',
        'see https://evil.example',
        'www.evil.example',
        'mailto:a@b.c',
        'javascript:alert(1)',
      ]) {
        expect(problemsOf('announcement', content({ title: bad }))).toHaveLength(1);
      }
      expect(problemsOf('announcement', content({ body: 'hi\u0000there' }))).toEqual([
        { path: 'content.body', code: 'format' },
      ]);
      expect(problemsOf('announcement', content({ body: 'a‮b' }))).toEqual([
        { path: 'content.body', code: 'format' },
      ]);
      expect(problemsOf('announcement', valid({ internalName: '<script>' }))).toEqual([
        { path: 'internalName', code: 'markup' },
      ]);
    });

    it('takes a link only as a typed reference, never a URL', () => {
      for (const type of ['category', 'product', 'seller', 'page']) {
        expect(parseDraft('link', content({ link: { type, id: UUID_B } })).ok).toBe(true);
      }
      expect(parseDraft('link', content({ link: { type: 'search', id: 'halal-meat' } })).ok).toBe(
        true,
      );
      const bad = (link: unknown) => problemsOf('link', content({ link }));
      expect(bad({ type: 'url', id: 'https://evil.example' })).toEqual([
        { path: 'content.link.type', code: 'enum' },
      ]);
      expect(bad({ type: 'category', id: 'https://evil.example' })).toEqual([
        { path: 'content.link.id', code: 'format' },
      ]);
      expect(bad({ type: 'search', id: 'https://evil.example' })).toEqual([
        { path: 'content.link.id', code: 'format' },
      ]);
      expect(bad({ type: 'page', id: UUID_A, href: '/x' })).toEqual([
        { path: 'content.link.href', code: 'unknown-field' },
      ]);
      expect(bad('https://evil.example')).toEqual([{ path: 'content.link', code: 'type' }]);
      expect(bad({ type: 'product' })).toEqual([{ path: 'content.link.id', code: 'required' }]);
    });

    it('checks the image: a key and alt text, or decorative with an empty alt', () => {
      const ok = (image: unknown) => parseDraft('announcement', content({ image }));
      expect(ok({ ref: 'eid-banner', alt: 'Eid lanterns' })).toMatchObject({
        ok: true,
        value: {
          content: { image: { ref: 'eid-banner', alt: 'Eid lanterns', decorative: false } },
        },
      });
      expect(ok({ ref: 'eid-banner', alt: '', decorative: true })).toMatchObject({
        ok: true,
        value: { content: { image: { ref: 'eid-banner', alt: '', decorative: true } } },
      });
      expect(ok({ ref: 'eid-banner', decorative: true }).ok).toBe(true);
      const bad = (image: unknown) => problemsOf('announcement', content({ image }));
      expect(bad({ ref: 'eid-banner' })).toEqual([{ path: 'content.image.alt', code: 'required' }]);
      expect(bad({ ref: 'eid-banner', alt: '' })).toEqual([
        { path: 'content.image.alt', code: 'required' },
      ]);
      expect(bad({ ref: 'eid-banner', alt: 'Lanterns', decorative: true })).toEqual([
        { path: 'content.image.alt', code: 'not-empty' },
      ]);
      expect(bad({ ref: 'https://cdn.example/x.png', alt: 'x' })).toEqual([
        { path: 'content.image.ref', code: 'format' },
      ]);
      expect(bad({ ref: 'a', alt: 'x', decorative: 'yes' })).toEqual([
        { path: 'content.image.decorative', code: 'type' },
      ]);
    });

    it('takes the text position and tone from closed lists', () => {
      for (const textPosition of ['start', 'center', 'end']) {
        for (const textTone of ['light', 'dark']) {
          expect(parseDraft('announcement', content({ textPosition, textTone }))).toMatchObject({
            ok: true,
            value: { content: { textPosition, textTone } },
          });
        }
      }
      expect(problemsOf('announcement', content({ textPosition: 'left' }))).toEqual([
        { path: 'content.textPosition', code: 'enum' },
      ]);
      expect(problemsOf('announcement', content({ textTone: 'red' }))).toEqual([
        { path: 'content.textTone', code: 'enum' },
      ]);
    });

    it('refuses a field outside the schema', () => {
      expect(problemsOf('announcement', content({ html: '<b>' }))).toEqual([
        { path: 'content.html', code: 'unknown-field' },
      ]);
      expect(problemsOf('announcement', valid({ extra: 1 }))).toEqual([
        { path: 'extra', code: 'unknown-field' },
      ]);
    });

    it('stores and reads content and placements back unchanged', () => {
      const parsed = parseDraft(
        'link',
        content({ link: { type: 'category', id: UUID_A }, image: { ref: 'a', alt: 'b' } }),
      );
      if (!parsed.ok) throw new Error('should parse');
      expect(readContent('link', storedContent(parsed.value.content))).toEqual(
        parsed.value.content,
      );
      expect(readContent('link', { title: 'x'.repeat(99) })).toBeNull();
      expect(readPlacements(storedPlacements(parsed.value.placements))).toEqual(
        parsed.value.placements,
      );
      expect(readPlacements('nope')).toEqual([]);
    });
  });

  describe('window', () => {
    it('requires an end after the start, at most 90 days (2160 hours) later', () => {
      const start = T0;
      expect(
        windowProblems({ startsAt: start, endsAt: start.add({ hours: MAX_WINDOW_HOURS }) }),
      ).toEqual([]);
      expect(
        windowProblems({
          startsAt: start,
          endsAt: start.add({ hours: MAX_WINDOW_HOURS, nanoseconds: 1 }),
        }),
      ).toEqual([{ path: 'endsAt', code: 'too-long' }]);
      expect(windowProblems({ startsAt: start, endsAt: start })).toEqual([
        { path: 'endsAt', code: 'before-start' },
      ]);
      expect(windowProblems({ startsAt: start, endsAt: start.subtract({ hours: 1 }) })).toEqual([
        { path: 'endsAt', code: 'before-start' },
      ]);
      expect(MAX_WINDOW_HOURS).toBe(2160);
    });

    it('requires the end and reads both as instants', () => {
      const noEnd: Record<string, unknown> = valid();
      delete noEnd.endsAt;
      expect(problemsOf('announcement', noEnd)).toEqual([{ path: 'endsAt', code: 'required' }]);
      expect(problemsOf('announcement', valid({ endsAt: 'tomorrow' }))).toEqual([
        { path: 'endsAt', code: 'format' },
      ]);
      expect(
        problemsOf('announcement', valid({ endsAt: T0.add({ hours: 24 * 91 }).toString() })),
      ).toEqual([{ path: 'endsAt', code: 'too-long' }]);
      // An offset is accepted and means the same instant.
      expect(
        parseDraft(
          'announcement',
          valid({ startsAt: '2026-10-23T10:00:00+10:00', endsAt: '2026-10-24T00:00:00Z' }),
        ).ok,
      ).toBe(true);
    });
  });

  describe('placements', () => {
    const place = (placements: unknown) => problemsOf('announcement', valid({ placements }));

    it('has the closed position list with its maximums and autoplay', () => {
      expect(Object.fromEntries(POSITIONS.map((p) => [p.key, [p.maxActive, p.autoplay]]))).toEqual({
        'home.hero': [8, true],
        'home.mid': [4, false],
        'category.top': [4, false],
        'product.below-details': [3, false],
        'cart.below-lines': [3, false],
        'landing.top': [8, true],
      });
      expect(positionOf('checkout.top')).toBeNull();
      expect(place([{ position: 'checkout.top' }])).toEqual([
        { path: 'placements[0].position', code: 'enum' },
      ]);
    });

    it('allows autoplay only at home.hero and landing.top', () => {
      expect(place([{ position: 'home.hero', autoplay: true }])).toEqual([]);
      expect(place([{ position: 'landing.top', autoplay: true }])).toEqual([]);
      for (const position of [
        'home.mid',
        'category.top',
        'product.below-details',
        'cart.below-lines',
      ]) {
        expect(place([{ position, autoplay: true }])).toEqual([
          { path: 'placements[0].autoplay', code: 'not-allowed-here' },
        ]);
      }
    });

    it('checks the scope: an id unless all, subcategories only for a category, a scope the position allows', () => {
      const cat = { position: 'category.top', scope: 'category', scopeId: UUID_A };
      expect(place([cat])).toEqual([]);
      expect(place([{ ...cat, includeSubcategories: true }])).toEqual([]);
      expect(place([{ position: 'category.top', scope: 'category' }])).toEqual([
        { path: 'placements[0].scopeId', code: 'required' },
      ]);
      expect(place([{ position: 'home.hero', scopeId: UUID_A }])).toEqual([
        { path: 'placements[0].scopeId', code: 'not-allowed' },
      ]);
      expect(place([{ position: 'home.hero', includeSubcategories: true }])).toEqual([
        { path: 'placements[0].includeSubcategories', code: 'not-allowed' },
      ]);
      expect(place([{ position: 'home.hero', scope: 'category', scopeId: UUID_A }])).toEqual([
        { path: 'placements[0].scope', code: 'not-allowed-here' },
      ]);
      expect(
        place([{ position: 'product.below-details', scope: 'seller', scopeId: UUID_A }]),
      ).toEqual([]);
      expect(place([{ position: 'landing.top', scope: 'page', scopeId: UUID_A }])).toEqual([]);
      expect(place([{ position: 'landing.top', scope: 'galaxy' }])).toEqual([
        { path: 'placements[0].scope', code: 'enum' },
      ]);
      expect(
        place([{ position: 'category.top', scope: 'category', scopeId: 'not-a-uuid' }]),
      ).toEqual([{ path: 'placements[0].scopeId', code: 'format' }]);
    });

    it('takes 1 to 10 placements, none twice', () => {
      expect(place([])).toEqual([{ path: 'placements', code: 'count' }]);
      expect(place([{ position: 'home.hero' }, { position: 'home.hero' }])).toEqual([
        { path: 'placements[1]', code: 'duplicate' },
      ]);
      expect(place([{ position: 'home.hero' }, { position: 'home.mid', sortOrder: 2 }])).toEqual(
        [],
      );
      expect(place([{ position: 'home.hero', sortOrder: -1 }])).toEqual([
        { path: 'placements[0].sortOrder', code: 'range' },
      ]);
      expect(place('home.hero')).toEqual([{ path: 'placements', code: 'type' }]);
    });
  });

  it('parses a new slide with its kind', () => {
    expect(parseNewSlide({ kind: 'announcement', ...valid() }).ok).toBe(true);
    expect(parseNewSlide({ ...valid() })).toEqual({
      ok: false,
      problems: [{ path: 'kind', code: 'required' }],
    });
    expect(parseNewSlide({ kind: 'banner', ...valid() })).toEqual({
      ok: false,
      problems: [{ path: 'kind', code: 'enum' }],
    });
    expect(parseNewSlide('x')).toEqual({ ok: false, problems: [{ path: '', code: 'type' }] });
  });

  describe('derived status', () => {
    const facts = (state: 'draft' | 'approved' | 'paused' | 'archived', extra = {}) => ({
      state,
      startsAt: T0,
      endsAt: T0.add({ hours: 48 }),
      draftVersionId: null,
      submittedVersionId: null,
      ...extra,
    });
    it('follows the stored state, the window and the clock', () => {
      expect(statusOf(facts('draft'), T0)).toBe('draft');
      expect(statusOf(facts('draft', { draftVersionId: 'v1', submittedVersionId: 'v1' }), T0)).toBe(
        'pending',
      );
      expect(statusOf(facts('draft', { draftVersionId: 'v2', submittedVersionId: 'v1' }), T0)).toBe(
        'draft',
      );
      expect(statusOf(facts('approved'), T0.subtract({ seconds: 1 }))).toBe('scheduled');
      expect(statusOf(facts('approved'), T0)).toBe('live');
      expect(statusOf(facts('approved'), T0.add({ hours: 48 }).subtract({ seconds: 1 }))).toBe(
        'live',
      );
      expect(statusOf(facts('approved'), T0.add({ hours: 48 }))).toBe('ended');
      expect(statusOf(facts('paused'), T0.add({ hours: 1 }))).toBe('paused');
      expect(statusOf(facts('archived'), T0.add({ hours: 1 }))).toBe('archived');
    });
  });

  describe('max active', () => {
    const slot = (
      id: string,
      from: number,
      to: number,
      scope: PlacedSlide['scope'] = 'all',
      scopeId: string | null = null,
      includeSubcategories = false,
    ): PlacedSlide & { slideId: string } => ({
      slideId: id,
      startsAt: T0.add({ hours: from }),
      endsAt: T0.add({ hours: to }),
      scope,
      scopeId,
      includeSubcategories,
    });
    const crowd = (n: number, from = 0, to = 100) =>
      Array.from({ length: n }, (_, i) => slot(`s${i}`, from, to));

    it('lets a slide in up to the maximum and refuses the one over it', () => {
      expect(capExceeded(slot('new', 0, 50), crowd(7), 8)).toBe(false);
      expect(capExceeded(slot('new', 0, 50), crowd(8), 8)).toBe(true);
      expect(capExceeded(slot('new', 0, 50), crowd(3), 4)).toBe(false);
      expect(capExceeded(slot('new', 0, 50), crowd(4), 4)).toBe(true);
    });

    it('counts only slides whose window meets the candidate, and the busiest instant', () => {
      // Four slides, but never more than two at one time.
      const staggered = [slot('a', 0, 10), slot('b', 5, 20), slot('c', 20, 30), slot('d', 25, 40)];
      expect(capExceeded(slot('new', 0, 40), staggered, 3)).toBe(false);
      expect(capExceeded(slot('new', 0, 40), staggered, 2)).toBe(true);
      // Windows that only touch do not overlap.
      expect(capExceeded(slot('new', 100, 110), crowd(8), 8)).toBe(false);
      expect(capExceeded(slot('new', 99, 110), crowd(8), 8)).toBe(true);
      // A slide in the same window starting inside the candidate's window counts.
      expect(capExceeded(slot('new', 0, 50), [...crowd(3, 0, 10), slot('late', 40, 60)], 4)).toBe(
        false,
      );
    });

    it('ignores the slide itself (its own old placement is replaced)', () => {
      expect(capExceeded(slot('s0', 0, 50), crowd(4), 4)).toBe(false);
    });

    it('counts only placements whose scope can show on the same page', () => {
      const cat = (id: string, scopeId: string, sub = false) =>
        slot(id, 0, 100, 'category', scopeId, sub);
      const two = [cat('x', UUID_A), cat('y', UUID_A)];
      expect(capExceeded(cat('new', UUID_B), two, 2)).toBe(false);
      expect(capExceeded(cat('new', UUID_A), two, 2)).toBe(true);
      expect(capExceeded(slot('new', 0, 50), two, 2)).toBe(true);
      expect(capExceeded(cat('new', UUID_B, true), two, 2)).toBe(true);
      expect(
        scopesMeet(
          { scope: 'product', scopeId: UUID_A, includeSubcategories: false },
          { scope: 'category', scopeId: UUID_B, includeSubcategories: false },
        ),
      ).toBe(true);
      expect(
        scopesMeet(
          { scope: 'seller', scopeId: UUID_A, includeSubcategories: false },
          { scope: 'seller', scopeId: UUID_B, includeSubcategories: false },
        ),
      ).toBe(false);
    });
  });
});
