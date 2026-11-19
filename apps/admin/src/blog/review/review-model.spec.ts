import { describe, expect, it } from 'vitest';
import type { ApiContent } from '../editor/types.ts';
import { blockLine, changesOf } from './review-model.ts';

const base: ApiContent = {
  title: 'Spring pantry',
  excerpt: 'Six blends.',
  body: [{ type: 'paragraph', text: 'Spring is here.' }],
  coverImageId: null,
  coverAlt: null,
  seoTitle: null,
  seoDescription: null,
  authorDisplay: null,
  categoryId: null,
  tagIds: [],
  links: [],
  event: null,
};

describe('blog review changes', () => {
  it('is empty for identical versions', () => {
    expect(changesOf(base, { ...base })).toEqual([]);
  });

  it('lists a changed title and body with both texts', () => {
    const open = { ...base, title: 'Spring pantry 2', body: [{ type: 'paragraph', text: 'New.' }] };
    expect(changesOf(open as ApiContent, base)).toEqual([
      { field: 'title', before: 'Spring pantry', after: 'Spring pantry 2' },
      { field: 'body', before: 'Spring is here.', after: 'New.' },
    ]);
  });

  it('counts every filled part as new when there is no live version', () => {
    const fields = changesOf(base, null).map((change) => change.field);
    expect(fields).toEqual(['title', 'excerpt', 'body']);
  });

  it('ignores the order of tags and shows removed parts with a null after', () => {
    const live = { ...base, tagIds: ['b', 'a'], excerpt: 'Old' };
    const open = { ...base, tagIds: ['a', 'b'], excerpt: '' };
    expect(changesOf(open, live)).toEqual([{ field: 'excerpt', before: 'Old', after: null }]);
  });

  it('writes one readable line per block type', () => {
    expect(blockLine({ type: 'heading', level: 2, text: 'Why' })).toBe('## Why');
    expect(blockLine({ type: 'list', ordered: true, items: ['a', 'b'] })).toBe('1. a\n2. b');
    expect(blockLine({ type: 'product_cards', productIds: ['p1', 'p2'] })).toBe(
      '[products] p1, p2',
    );
  });
});
