import { describe, expect, it } from 'vitest';
import {
  MODULE_SCHEMAS,
  blankConfig,
  configOf,
  getAt,
  isEditableModule,
  moved,
  pathText,
  prune,
  setAt,
} from './module-schema.ts';

describe('paths', () => {
  it('spells a path the way the API does', () => {
    expect(pathText(['config', 'items', 0, 'text'])).toBe('config.items[0].text');
    expect(pathText(['config', 'blocks', 1, 'spans', 0, 'href'])).toBe(
      'config.blocks[1].spans[0].href',
    );
  });

  it('reads and sets a value deep inside, copying what is on the way', () => {
    const before = { items: [{ text: 'a' }, { text: 'b' }], keep: { x: 1 } };
    const after = setAt(before, ['items', 1, 'text'], 'c');
    expect(after).toEqual({ items: [{ text: 'a' }, { text: 'c' }], keep: { x: 1 } });
    expect(before.items[1]).toEqual({ text: 'b' });
    expect(after.keep).toBe(before.keep);
    expect(getAt(after, ['items', 1, 'text'])).toBe('c');
    expect(getAt(after, ['nope', 0, 'text'])).toBeUndefined();
  });

  it('makes the objects and lists a new path needs', () => {
    expect(setAt({}, ['image', 'ref'], 'fruits')).toEqual({ image: { ref: 'fruits' } });
    expect(setAt({}, ['items', 0, 'text'], 'a')).toEqual({ items: [{ text: 'a' }] });
  });
});

describe('what is sent', () => {
  it('leaves out empty texts, empty objects and empty lists', () => {
    expect(
      configOf({
        title: 'Hello',
        subtitle: '   ',
        image: { ref: '', alt: '' },
        items: [{ icon: 'tax', text: '', href: '' }],
        spans: [{ text: '' }],
      }),
    ).toEqual({ title: 'Hello', items: [{ icon: 'tax' }], spans: [{}] });
  });

  it('keeps a half-filled image so the API names what is missing', () => {
    expect(configOf({ image: { ref: 'fruits', alt: '' } })).toEqual({ image: { ref: 'fruits' } });
  });

  it('keeps numbers, booleans and settings the form does not show', () => {
    expect(prune({ limit: 0, on: false, categoryIds: ['a'], productId: 'p' })).toEqual({
      limit: 0,
      on: false,
      categoryIds: ['a'],
      productId: 'p',
    });
  });

  it('trims texts and keeps empty rows in place so error paths stay on their rows', () => {
    expect(prune({ items: [{ text: ' a ' }, { text: '' }, { text: 'c' }] })).toEqual({
      items: [{ text: 'a' }, {}, { text: 'c' }],
    });
  });

  it('sends an empty object when nothing is set', () => {
    expect(configOf({ title: '' })).toEqual({});
  });
});

describe('moving a row', () => {
  it('swaps with the neighbour and stays put at the ends', () => {
    expect(moved(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
    expect(moved(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moved(['a', 'b', 'c'], 0, -1)).toEqual(['a', 'b', 'c']);
    expect(moved(['a', 'b', 'c'], 2, 1)).toEqual(['a', 'b', 'c']);
  });
});

describe('the module catalogue', () => {
  it('has a form for every module of the pages and none for the navigation', () => {
    expect(Object.keys(MODULE_SCHEMAS).sort()).toEqual([
      'banner',
      'brand-header',
      'category-circles',
      'faq',
      'image-text',
      'info-strip',
      'product-shelf',
      'product-spotlight',
      'sellers-near-you',
      'text-block',
    ]);
    expect(isEditableModule('nav-link')).toBe(false);
  });

  it('starts a new module with what the API needs to see', () => {
    expect(blankConfig('product-shelf')).toEqual({
      source: { kind: 'bestsellers' },
      limit: 12,
    });
    expect(blankConfig('info-strip')).toEqual({ items: [{ icon: 'delivery' }] });
    expect(blankConfig('banner')).toEqual({});
  });
});
