import { Temporal } from '@mondapac/shared-kernel';
import {
  blocking,
  hasExternalLink,
  hasHealthWording,
  hasPriceLikeText,
  readableTexts,
  runChecks,
  statusMessageFindings,
} from './checks';
import type { CheckFacts } from './checks';
import { parsePostContent } from './content';
import type { ContentRules, PostContent } from './content';

const ID = (n: number): string => `0197a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const SELLER = ID(900);
const now = Temporal.Instant.from('2026-10-28T00:00:00Z');

const contentOf = (input: Record<string, unknown>, rules: ContentRules): PostContent => {
  const parsed = parsePostContent(input, rules);
  if (parsed.content === null) throw new Error(JSON.stringify(parsed.problems));
  return parsed.content;
};

const complete = {
  title: 'Ramadan table',
  excerpt: 'A short one',
  coverImageId: ID(50),
  coverAlt: 'A laid table',
  categoryId: ID(60),
  body: [{ type: 'paragraph', text: 'Some words.' }],
};

const facts = (
  change: Partial<CheckFacts> & { input?: Record<string, unknown>; rules?: ContentRules },
): CheckFacts => {
  const { input, rules: given, ...rest } = change;
  const rules = given ?? { kind: 'news', ownerType: 'platform', timeZone: 'Asia/Tokyo' };
  return {
    kind: rules.kind,
    ownerType: rules.ownerType,
    sellerId: rules.ownerType === 'seller' ? SELLER : null,
    content: contentOf({ ...complete, ...input }, rules),
    now,
    currencyCode: 'AUD',
    healthTerms: ['cures', 'detox'],
    products: new Map(),
    claims: { hitPaths: new Set() },
    ...rest,
  };
};

const codes = (findings: readonly { code: string }[]) => findings.map((f) => f.code);

describe('automatic checks', () => {
  it('passes a complete news post with nothing to say', () => {
    expect(runChecks(facts({}))).toEqual([]);
  });

  it('blocks a post with no cover, cover alt, category or body', () => {
    const found = runChecks(facts({ input: { coverImageId: null, categoryId: null, body: [] } }));
    expect(codes(blocking(found)).sort()).toEqual([
      'body-empty',
      'category-missing',
      'cover-missing',
    ]);
    const alt = runChecks(facts({ input: { coverAlt: null } }));
    expect(codes(blocking(alt))).toEqual(['cover-alt-missing']);
  });

  it('blocks an image with no alt text, by block', () => {
    const found = runChecks(
      facts({
        input: {
          body: [
            { type: 'paragraph', text: 'x' },
            { type: 'image', imageId: ID(7), alt: '' },
          ],
        },
      }),
    );
    expect(blocking(found)).toEqual([
      { severity: 'error', code: 'image-alt-missing', path: 'body[1]' },
    ]);
  });

  it('asks a product post for a product on sale and a brand post for a brand', () => {
    const product = facts({
      rules: { kind: 'product', ownerType: 'platform', timeZone: 'Asia/Tokyo' },
    });
    expect(codes(blocking(runChecks(product)))).toEqual(['product-link-missing']);
    const brand = facts({
      rules: { kind: 'brand', ownerType: 'platform', timeZone: 'Asia/Tokyo' },
    });
    expect(codes(blocking(runChecks(brand)))).toEqual(['brand-link-missing']);
  });

  it('blocks a product that is not on sale, and one the seller does not sell', () => {
    const rules: ContentRules = { kind: 'product', ownerType: 'seller', timeZone: 'Asia/Tokyo' };
    const input = {
      links: [
        { type: 'product', id: ID(1) },
        { type: 'product', id: ID(2) },
        { type: 'product', id: ID(3) },
      ],
    };
    const products = new Map([
      [ID(1), { onSale: true, soldBySeller: true }],
      [ID(2), { onSale: false, soldBySeller: true }],
      [ID(3), { onSale: true, soldBySeller: false }],
    ]);
    const found = runChecks(facts({ rules, input, products }));
    expect(blocking(found)).toEqual([
      { severity: 'error', code: 'product-not-on-sale', path: 'links[1]' },
      { severity: 'error', code: 'product-not-own', path: 'links[2]' },
    ]);
  });

  it('fails closed when the catalog could not be asked', () => {
    const rules: ContentRules = { kind: 'product', ownerType: 'platform', timeZone: 'Asia/Tokyo' };
    const found = runChecks(
      facts({ rules, input: { links: [{ type: 'product', id: ID(1) }] }, products: null }),
    );
    expect(codes(blocking(found))).toEqual(['products-unverifiable']);
  });

  it("blocks a seller's link to another seller", () => {
    const rules: ContentRules = { kind: 'brand', ownerType: 'seller', timeZone: 'Asia/Tokyo' };
    const found = runChecks(
      facts({
        rules,
        input: {
          links: [
            { type: 'brand', id: ID(5) },
            { type: 'seller', id: ID(6) },
          ],
          body: [{ type: 'seller_card', sellerId: ID(7) }],
        },
      }),
    );
    expect(blocking(found)).toEqual([
      { severity: 'error', code: 'seller-link-not-own', path: 'links[0]' },
      { severity: 'error', code: 'seller-link-not-own', path: 'links[2]' },
    ]);
    expect(codes(found)).toContain('brand-link-unverified');
  });

  it('blocks an event with no details or one that has ended, and notes a registration link', () => {
    const rules: ContentRules = { kind: 'event', ownerType: 'platform', timeZone: 'Asia/Tokyo' };
    expect(codes(blocking(runChecks(facts({ rules }))))).toEqual(['event-missing']);
    const past = { startsAt: '2026-10-01T10:00', endsAt: '2026-10-01T12:00', attendance: 'online' };
    expect(codes(blocking(runChecks(facts({ rules, input: { event: past } }))))).toEqual([
      'event-ended',
    ]);
    const future = {
      startsAt: '2026-12-01T10:00',
      endsAt: '2026-12-01T12:00',
      attendance: 'online',
      registrationUrl: 'https://tix.test/e',
    };
    const found = runChecks(facts({ rules, input: { event: future } }));
    expect(blocking(found)).toEqual([]);
    expect(codes(found)).toEqual(['registration-url-present']);
  });

  it('blocks a link to another site in any text but not the registration URL', () => {
    for (const text of [
      'See https://shop.test/x',
      'Visit www.shop.test',
      'Mail me@shop.test',
      'Go to shop.com now',
    ]) {
      expect(hasExternalLink(text)).toBe(true);
    }
    for (const text of [
      'Halal certified since 2010.',
      'Mix 1.5 cups, e.g. rice.',
      'Open Mon.-Fri.',
    ]) {
      expect(hasExternalLink(text)).toBe(false);
    }
    const found = runChecks(
      facts({ input: { body: [{ type: 'paragraph', text: 'Buy at shop.com today' }] } }),
    );
    expect(blocking(found)).toEqual([
      { severity: 'error', code: 'external-link', path: 'body[0]' },
    ]);
  });

  it('blocks a certification claim at the path the certification check named', () => {
    const found = runChecks(facts({ claims: { hitPaths: new Set(['body[0]']) } }));
    expect(blocking(found)).toEqual([
      { severity: 'error', code: 'certification-claim', path: 'body[0]' },
    ]);
    expect(codes(blocking(runChecks(facts({ claims: null }))))).toEqual(['claims-unverifiable']);
  });

  it('warns about a price and about health wording, and does not block', () => {
    const found = runChecks(
      facts({
        input: {
          body: [
            { type: 'paragraph', text: 'Only $12 this week' },
            { type: 'paragraph', text: 'This tea cures everything' },
          ],
        },
      }),
    );
    expect(blocking(found)).toEqual([]);
    expect(found).toEqual([
      { severity: 'warning', code: 'price-in-text', path: 'body[0]' },
      { severity: 'warning', code: 'health-wording', path: 'body[1]' },
    ]);
  });

  it('reads the currency code and the health terms of the Market', () => {
    expect(hasPriceLikeText('costs 1,200 JPY', 'JPY')).toBe(true);
    expect(hasPriceLikeText('costs 1,200 JPY', 'AUD')).toBe(false);
    expect(hasPriceLikeText('year 2026', 'AUD')).toBe(false);
    expect(hasHealthWording('A blargheal drink', ['blargheal'])).toBe(true);
    expect(hasHealthWording('Unblarghealed', ['blargheal'])).toBe(false);
  });

  it('warns about an empty excerpt', () => {
    expect(runChecks(facts({ input: { excerpt: '' } }))).toEqual([
      { severity: 'warning', code: 'excerpt-missing', path: 'excerpt' },
    ]);
  });
});

describe('event texts and status messages', () => {
  it('reads the venue name and address of an event as texts readers see', () => {
    const texts = readableTexts({
      ...contentOf(complete, { kind: 'news', ownerType: 'platform', timeZone: 'Asia/Tokyo' }),
      event: {
        startsAt: now,
        endsAt: now.add({ hours: 2 }),
        timeZone: 'Asia/Tokyo',
        attendance: 'offline',
        venueName: 'Hall at www.example.com',
        address: '1 Main St, ISO certified kitchen',
        registrationUrl: null,
        eventStatus: 'scheduled',
        statusMessage: null,
      },
    } as never);
    expect(texts).toEqual(
      expect.arrayContaining([
        { path: 'event.venueName', text: 'Hall at www.example.com' },
        { path: 'event.address', text: '1 Main St, ISO certified kitchen' },
      ]),
    );
  });

  it('checks a status message for outside links and claims, and fails closed', () => {
    expect(statusMessageFindings('Moved to Friday', false)).toEqual([]);
    expect(statusMessageFindings('See www.example.com', false)).toEqual([
      { severity: 'error', code: 'external-link', path: 'message' },
    ]);
    expect(statusMessageFindings('Moved', true)).toEqual([
      { severity: 'error', code: 'certification-claim', path: 'message' },
    ]);
    expect(statusMessageFindings('Moved', null)).toEqual([
      { severity: 'error', code: 'claims-unverifiable', path: null },
    ]);
  });
});
