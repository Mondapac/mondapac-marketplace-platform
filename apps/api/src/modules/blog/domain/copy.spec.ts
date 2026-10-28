import { copyContent } from './copy';
import { parsePostContent } from './content';

const ID = (n: number): string => `0197a000-0000-7000-8000-${String(n).padStart(12, '0')}`;

describe('copy to another Market', () => {
  const parsed = parsePostContent(
    {
      title: 'Eid table',
      excerpt: 'Short',
      coverImageId: ID(1),
      coverAlt: 'A table',
      categoryId: ID(2),
      tagIds: [ID(3)],
      links: [{ type: 'brand', id: ID(4) }],
      body: [
        { type: 'paragraph', text: 'Text' },
        { type: 'image', imageId: ID(5), alt: 'x' },
        { type: 'product_cards', productIds: [ID(6)] },
        { type: 'seller_card', sellerId: ID(7) },
        { type: 'tip', title: null, text: 'Tip' },
      ],
      event: {
        startsAt: '2026-12-01T10:00',
        endsAt: '2026-12-01T12:00',
        attendance: 'online',
        timeZone: 'Asia/Tokyo',
      },
    },
    { kind: 'event', ownerType: 'platform', timeZone: 'Asia/Tokyo' },
  );

  it('keeps the writing and the event, and leaves behind what is bound to this Market', () => {
    const copy = copyContent('event', parsed.content!);
    expect(copy.content.body.map((block) => block.type)).toEqual(['paragraph', 'tip']);
    expect(copy.content).toMatchObject({
      title: 'Eid table',
      excerpt: 'Short',
      coverImageId: null,
      coverAlt: null,
      categoryId: null,
      tagIds: [],
      links: [],
    });
    expect(copy.content.event?.timeZone).toBe('Asia/Tokyo');
    expect([...copy.left].sort()).toEqual([
      'cards',
      'category',
      'cover',
      'images',
      'links',
      'tags',
    ]);
  });

  it('resets the status of an event to scheduled', () => {
    const content = {
      ...parsed.content!,
      event: {
        ...parsed.content!.event!,
        eventStatus: 'cancelled' as const,
        statusMessage: 'Closed',
      },
    };
    expect(copyContent('event', content).content.event).toMatchObject({
      eventStatus: 'scheduled',
      statusMessage: null,
    });
  });
});
