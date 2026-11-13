import { describe, expect, it } from 'vitest';
import {
  contentOf,
  draftOf,
  emptyBlock,
  isDirty,
  itemsOf,
  move,
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
  event: { startsAt: '2026-11-15T09:00:00.000Z', timeZone: 'Australia/Sydney' },
};

describe('editor model', () => {
  it('round-trips a version, keeping the blocks it has no control for as they are', () => {
    const draft = draftOf(content, 'spring-pantry');
    expect(contentOf(draft)).toEqual(content);
    expect(draft.blocks.filter((block) => block.type === 'kept')).toHaveLength(2);
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
});
