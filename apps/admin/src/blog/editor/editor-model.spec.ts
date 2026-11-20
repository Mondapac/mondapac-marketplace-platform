import { describe, expect, it } from 'vitest';
import {
  contentOf,
  draftOf,
  coverNeedsAlt,
  emptyBlock,
  emptyImageBlock,
  isDirty,
  itemsOf,
  move,
  savedIndexOf,
  type Draft,
} from './editor-model.ts';
import type { ApiContent } from './types.ts';

const content: ApiContent = {
  title: 'Spring pantry',
  excerpt: 'Six blends.',
  body: [
    { type: 'paragraph', text: 'Spring is here.' },
    { type: 'heading', level: 3, text: 'Baharat' },
    { type: 'list', ordered: true, items: ['one', 'two'] },
    { type: 'quote', text: 'Good.', attribution: null },
    { type: 'tip', title: null, text: 'Toast it.' },
    { type: 'image', imageId: '0190a000-0000-7000-8000-000000000009', alt: 'Jars', caption: null },
    { type: 'product_cards', productIds: ['0190a000-0000-7000-8000-000000000001'] },
  ],
  coverImageId: null,
  coverAlt: null,
  seoTitle: null,
  seoDescription: null,
  authorDisplay: null,
  categoryId: null,
  tagIds: ['0190a000-0000-7000-8000-000000000002'],
  links: [{ type: 'brand', id: '0190a000-0000-7000-8000-000000000003' }],
  event: null,
};

describe('editor model', () => {
  it('round-trips a version, keeping the blocks it has no control for as they are', () => {
    const draft = draftOf(content, 'spring-pantry');
    expect(contentOf(draft)).toEqual(content);
    // The product cards are kept; the image block is edited.
    expect(draft.blocks.filter((block) => block.type === 'kept')).toHaveLength(1);
    expect(draft.blocks.filter((block) => block.type === 'image')).toHaveLength(1);
  });

  it('shows an event on the clock of its zone and sends local times back without its live status', () => {
    const withEvent: ApiContent = {
      ...content,
      event: {
        startsAt: '2026-11-15T07:00:00.000Z',
        endsAt: '2026-11-15T09:30:00.000Z',
        timeZone: 'Australia/Brisbane',
        attendance: 'mixed',
        venueName: 'Hall',
        address: null,
        registrationUrl: 'https://example.com/r',
        eventStatus: 'postponed',
        statusMessage: 'Later',
      },
    };
    const draft = draftOf(withEvent, 'x', 'UTC');
    expect(draft.event).toEqual({
      startsAt: '2026-11-15T17:00',
      endsAt: '2026-11-15T19:30',
      timeZone: 'Australia/Brisbane',
      attendance: 'mixed',
      venueName: 'Hall',
      address: '',
      registrationUrl: 'https://example.com/r',
    });
    expect(contentOf(draft).event).toEqual({
      startsAt: '2026-11-15T17:00',
      endsAt: '2026-11-15T19:30',
      timeZone: 'Australia/Brisbane',
      attendance: 'mixed',
      venueName: 'Hall',
      address: null,
      registrationUrl: 'https://example.com/r',
    });
    expect(isDirty(draft, draft)).toBe(false);
  });

  it('sends empty optional text as null and trims', () => {
    const draft: Draft = {
      ...draftOf(content, 'x'),
      title: '  Title  ',
      coverAlt: '   ',
      seoTitle: ' SEO ',
    };
    const body = contentOf(draft);
    expect(body.title).toBe('Title');
    expect(body.coverAlt).toBeNull();
    expect(body.seoTitle).toBe('SEO');
  });

  it('leaves a text block with nothing in it out of what is saved', () => {
    const draft = draftOf(content, 'x');
    const withBlanks: Draft = {
      ...draft,
      blocks: [...draft.blocks, emptyBlock('paragraph'), emptyBlock('list'), emptyBlock('tip')],
    };
    expect(contentOf(withBlanks).body).toHaveLength(content.body.length);
  });

  it('makes one list item per non-empty line', () => {
    expect(itemsOf(' a \n\n b\n')).toEqual(['a', 'b']);
  });

  it('sees a change, and no change after a revert', () => {
    const saved = draftOf(content, 'slug');
    expect(isDirty(saved, saved)).toBe(false);
    expect(isDirty({ ...saved, title: 'Other' }, saved)).toBe(true);
    expect(isDirty({ ...saved, slug: 'other' }, saved)).toBe(true);
    // Only spaces around a title are not a change.
    expect(isDirty({ ...saved, title: ' Spring pantry ' }, saved)).toBe(false);
  });

  it('moves a block, and ignores a move outside the list', () => {
    expect(move([1, 2, 3], 0, 1)).toEqual([2, 1, 3]);
    expect(move([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(move([1, 2, 3], 2, 3)).toEqual([1, 2, 3]);
  });

  describe('image blocks and the cover', () => {
    const IMAGE = '0190a000-0000-7000-8000-000000000009';

    it('turns an image block into fields and back, with a null caption for an empty one', () => {
      const draft = draftOf(content, 'x');
      const image = draft.blocks.find((block) => block.type === 'image');
      expect(image).toMatchObject({ imageId: IMAGE, alt: 'Jars', caption: '' });
      const edited: Draft = {
        ...draft,
        blocks: draft.blocks.map((block) =>
          block.type === 'image'
            ? { ...block, alt: '  Spice jars ', caption: ' On a shelf ' }
            : block,
        ),
      };
      expect(contentOf(edited).body[5]).toEqual({
        type: 'image',
        imageId: IMAGE,
        alt: 'Spice jars',
        caption: 'On a shelf',
      });
      expect(isDirty(edited, draft)).toBe(true);
    });

    it('saves a chosen picture with its alt text still empty, and leaves out one with no picture', () => {
      const base = draftOf(content, 'x');
      const chosen = { ...emptyImageBlock(), imageId: IMAGE };
      const withBoth: Draft = { ...base, blocks: [...base.blocks, chosen, emptyImageBlock()] };
      const body = contentOf(withBoth).body;
      expect(body).toHaveLength(content.body.length + 1);
      expect(body.at(-1)).toEqual({ type: 'image', imageId: IMAGE, alt: '', caption: null });
    });

    it('names a block by its place in the saved body, which leaves blank blocks out', () => {
      const base = draftOf(content, 'x');
      const blocks = [emptyBlock('paragraph'), ...base.blocks, emptyImageBlock()];
      expect(savedIndexOf(blocks, 0)).toBeNull();
      expect(savedIndexOf(blocks, 1)).toBe(0);
      expect(savedIndexOf(blocks, 6)).toBe(5);
      expect(savedIndexOf(blocks, blocks.length - 1)).toBeNull();
      expect(savedIndexOf(blocks, 99)).toBeNull();
    });

    it('asks for the cover alt text only when a cover is set', () => {
      const base = draftOf(content, 'x');
      expect(coverNeedsAlt(base)).toBe(false);
      expect(coverNeedsAlt({ ...base, coverImageId: IMAGE, coverAlt: ' ' })).toBe(true);
      expect(coverNeedsAlt({ ...base, coverImageId: IMAGE, coverAlt: 'Jars' })).toBe(false);
      expect(contentOf({ ...base, coverImageId: '', coverAlt: '' }).coverImageId).toBeNull();
    });
  });
});
