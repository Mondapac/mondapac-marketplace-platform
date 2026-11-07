import { describe, expect, it } from 'vitest';
import {
  attributeDiffs,
  attributeText,
  idDiffs,
  photoTiles,
  textDiffs,
  variantDiffs,
} from './diff.ts';
import { CATEGORY, IMG, VARIANT, published, revision } from './fixtures.ts';

describe('version diff', () => {
  it('compares texts per locale, the panel locale first, and folds unchanged locales', () => {
    const groups = textDiffs(revision, published, 'en-AU');
    expect(groups.map((group) => [group.locale, group.changed])).toEqual([
      ['en-AU', true],
      ['ar', false],
    ]);
    const en = groups[0]!.rows;
    expect(en.map((row) => [row.field, row.change])).toEqual([
      ['name', 'changed'],
      ['shortDescription', 'same'],
      ['description', 'added'],
    ]);
    expect(en[0]).toMatchObject({ before: 'Olive oil', after: 'Extra virgin olive oil' });
  });

  it('treats every text of a first publication as added', () => {
    const rows = textDiffs(revision, null, 'en-AU')[0]!.rows;
    expect(rows.map((row) => row.change)).toEqual(['added', 'added', 'added']);
  });

  it('lists ids in the version order, then the removed ones', () => {
    expect(idDiffs(revision.categoryIds, published.categoryIds)).toEqual([
      { id: CATEGORY(2), change: 'added' },
      { id: CATEGORY(1), change: 'removed' },
    ]);
    expect(idDiffs([IMG(1)], null)).toEqual([{ id: IMG(1), change: 'added' }]);
  });

  it('marks variants added, removed and changed by id', () => {
    expect(variantDiffs(revision, published).map((row) => [row.variantId, row.change])).toEqual([
      [VARIANT(1), 'changed'],
      [VARIANT(3), 'added'],
      [VARIANT(2), 'removed'],
    ]);
  });

  it('keeps only the attributes that changed', () => {
    expect(attributeDiffs(revision, published)).toEqual([
      { code: 'organic', before: null, after: true, change: 'added' },
    ]);
    expect(attributeText({ 'en-AU': 'Red', ar: 'أحمر' }, 'en-AU')).toBe('Red');
    expect(attributeText(['a', 2], 'en-AU')).toBe('a, 2');
  });

  it('marks photos new, kept or taken down, in position order', () => {
    const tiles = photoTiles(
      [
        { imageId: IMG(3), position: 2, state: 'clean', width: 1, height: 1 },
        { imageId: IMG(1), position: 1, state: 'clean', width: 1, height: 1 },
        { imageId: IMG(4), position: 3, state: 'taken-down', width: 1, height: 1 },
      ],
      published.imageIds,
    );
    expect(tiles.map((tile) => [tile.imageId, tile.mark])).toEqual([
      [IMG(1), 'kept'],
      [IMG(3), 'new'],
      [IMG(4), 'taken-down'],
    ]);
  });
});
