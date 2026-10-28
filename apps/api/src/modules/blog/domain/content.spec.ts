import { linksOf, parsePostContent } from './content';
import type { ContentRules } from './content';

const ID = (n: number): string => `0197a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
const platformNews: ContentRules = {
  kind: 'news',
  ownerType: 'platform',
  timeZone: 'Australia/Brisbane',
};
const sellerProduct: ContentRules = {
  kind: 'product',
  ownerType: 'seller',
  timeZone: 'Asia/Tokyo',
};

describe('post content', () => {
  it('needs only a title for a draft', () => {
    const { content, problems } = parsePostContent({ title: 'Ramadan table' }, platformNews);
    expect(problems).toEqual([]);
    expect(content).toMatchObject({
      title: 'Ramadan table',
      excerpt: '',
      body: [],
      tagIds: [],
      event: null,
    });
  });

  it('refuses an unknown field, a missing title and markup', () => {
    expect(parsePostContent({ title: 'x', html: '<p>' }, platformNews).problems).toEqual([
      { path: 'html', code: 'unknown-field' },
    ]);
    expect(parsePostContent({}, platformNews).problems).toEqual([
      { path: 'title', code: 'required' },
    ]);
    expect(parsePostContent({ title: '<i>x</i>' }, platformNews).problems).toEqual([
      { path: 'title', code: 'markup' },
    ]);
    expect(parsePostContent('x', platformNews).problems).toEqual([{ path: '', code: 'type' }]);
  });

  it('refuses event details on a post that is not an event, and accepts them on an event', () => {
    const event = {
      startsAt: '2026-12-01T10:00',
      endsAt: '2026-12-01T12:00',
      attendance: 'offline',
      venueName: 'Town hall',
    };
    expect(parsePostContent({ title: 'x', event }, platformNews).problems).toEqual([
      { path: 'event', code: 'not-allowed' },
    ]);
    const parsed = parsePostContent({ title: 'x', event }, { ...platformNews, kind: 'event' });
    expect(parsed.problems).toEqual([]);
    expect(parsed.content?.event?.timeZone).toBe('Australia/Brisbane');
  });

  it('gives a seller post no byline and only product, seller and brand links', () => {
    expect(parsePostContent({ title: 'x', authorDisplay: 'Me' }, sellerProduct).problems).toEqual([
      { path: 'authorDisplay', code: 'not-allowed' },
    ]);
    expect(
      parsePostContent({ title: 'x', links: [{ type: 'page', id: ID(1) }] }, sellerProduct)
        .problems,
    ).toEqual([{ path: 'links[0].type', code: 'not-allowed' }]);
    expect(
      parsePostContent({ title: 'x', links: [{ type: 'brand', id: ID(1) }] }, sellerProduct)
        .problems,
    ).toEqual([]);
  });

  it('refuses too many tags, duplicate tags and a bad category id', () => {
    const tagIds = Array.from({ length: 11 }, (_v, i) => ID(i + 1));
    expect(parsePostContent({ title: 'x', tagIds }, platformNews).problems).toEqual([
      { path: 'tagIds', code: 'count' },
    ]);
    expect(parsePostContent({ title: 'x', tagIds: [ID(1), ID(1)] }, platformNews).problems).toEqual(
      [{ path: 'tagIds', code: 'duplicate' }],
    );
    expect(parsePostContent({ title: 'x', categoryId: 'x' }, platformNews).problems).toEqual([
      { path: 'categoryId', code: 'format' },
    ]);
  });

  it('lists the links of the cards first, then the added ones, once each', () => {
    const { content } = parsePostContent(
      {
        title: 'x',
        body: [
          { type: 'product_cards', productIds: [ID(1), ID(2)] },
          { type: 'seller_card', sellerId: ID(3) },
        ],
        links: [
          { type: 'product', id: ID(2) },
          { type: 'brand', id: ID(4) },
        ],
      },
      platformNews,
    );
    expect(linksOf(content!)).toEqual([
      { type: 'product', id: ID(1) },
      { type: 'product', id: ID(2) },
      { type: 'seller', id: ID(3) },
      { type: 'brand', id: ID(4) },
    ]);
  });

  it('refuses more than 30 links in all', () => {
    const links = Array.from({ length: 31 }, (_v, i) => ({ type: 'brand', id: ID(i + 1) }));
    expect(parsePostContent({ title: 'x', links }, platformNews).problems).toEqual([
      { path: 'links', code: 'count' },
    ]);
  });
});
