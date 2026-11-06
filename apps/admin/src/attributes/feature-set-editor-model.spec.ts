import { describe, expect, it } from 'vitest';
import {
  addEntry,
  addGroup,
  codesOf,
  fromDetail,
  isDirty,
  moveEntry,
  moveGroup,
  removeEntry,
  removeGroup,
  removedMaterial,
  setLevel,
  tightened,
  toRequest,
  variantCount,
  type EditorEntry,
} from './feature-set-editor-model.ts';
import type { FeatureSetDetail } from './types.ts';

const MARKETS = [
  { name: 'AU', locale: 'en-AU', other: 'fa-IR' },
  { name: 'ZZ', locale: 'ja-JP', other: 'ar-SA' },
] as const;

describe.each(MARKETS)('feature set editor model in market $name', ({ locale, other }) => {
  const entry = (code: string, over: Partial<EditorEntry> = {}): EditorEntry => ({
    code,
    level: 'optional',
    names: { [locale]: code },
    dataType: 'text',
    isVariantOption: false,
    material: false,
    ...over,
  });
  const detail: FeatureSetDetail = {
    id: 'f1',
    code: 'pantry',
    status: 'active',
    revisionNo: 3,
    version: 7,
    names: { [locale]: 'Pantry' },
    createdAt: '2026-11-01T00:00:00Z',
    groups: [
      {
        groupCode: 'core',
        names: { [locale]: 'Core' },
        attributes: [
          {
            code: 'brand',
            required: false,
            level: 'recommended',
            isVariantOption: false,
            attributeId: null,
            names: null,
            dataType: 'brand' as never,
            status: 'active',
            material: false,
          },
          {
            code: 'origin',
            required: true,
            level: 'required',
            isVariantOption: false,
            attributeId: null,
            names: null,
            dataType: 'text',
            status: 'active',
            material: true,
          },
        ],
      },
      {
        groupCode: 'storage',
        names: { [locale]: 'Storage' },
        attributes: [
          {
            code: 'shelf',
            required: false,
            isVariantOption: false,
            attributeId: null,
            names: null,
            dataType: 'text',
            status: 'active',
            material: false,
          },
        ],
      },
    ],
    productCount: 12,
    locales: { default: locale, supported: [locale, other] },
  };
  const state = fromDetail(detail);

  it('reads levels, and falls back to required or optional when the API sends none', () => {
    expect(state.groups[0]?.entries.map((e) => e.level)).toEqual(['recommended', 'required']);
    expect(state.groups[1]?.entries[0]?.level).toBe('optional');
  });

  it('builds the save request with the version and without empty names', () => {
    const named = { ...state, names: { [locale]: ' Pantry ', [other]: '  ' } };
    expect(toRequest(named, 7)).toMatchObject({
      version: 7,
      names: { [locale]: 'Pantry' },
      groups: [
        {
          groupCode: 'core',
          attributes: [
            { code: 'brand', level: 'recommended' },
            { code: 'origin', level: 'required' },
          ],
        },
        { groupCode: 'storage', attributes: [{ code: 'shelf', level: 'optional' }] },
      ],
    });
  });

  it('keeps the core group first and fixed', () => {
    expect(moveGroup(state, 0, 1)).toBe(state);
    expect(removeGroup(state, 0)).toBe(state);
    const more = addGroup(state, 'other', { [locale]: 'Other' });
    expect(moveGroup(more, 2, -1).groups.map((g) => g.groupCode)).toEqual([
      'core',
      'other',
      'storage',
    ]);
    expect(moveGroup(more, 1, -1)).toBe(more);
    expect(removeGroup(more, 2).groups.map((g) => g.groupCode)).toEqual(['core', 'storage']);
  });

  it('does not add a group code twice, nor an attribute the set already holds', () => {
    expect(addGroup(state, 'storage', {})).toBe(state);
    expect(addEntry(state, 1, entry('brand'))).toBe(state);
    expect(codesOf(addEntry(state, 1, entry('tray'))).has('tray')).toBe(true);
  });

  it('moves and removes entries, and stops at the ends', () => {
    const two = addEntry(state, 1, entry('tray'));
    expect(moveEntry(two, 1, 0, 1).groups[1]?.entries.map((e) => e.code)).toEqual([
      'tray',
      'shelf',
    ]);
    expect(moveEntry(two, 1, 0, -1)).toEqual(two);
    expect(removeEntry(two, 1, 0).groups[1]?.entries.map((e) => e.code)).toEqual(['tray']);
  });

  it('lists what becomes required: raised or added as required, not what already was', () => {
    let next = setLevel(state, 1, 0, 'required');
    next = addEntry(next, 1, entry('tray', { level: 'required' }));
    next = setLevel(next, 0, 0, 'optional');
    expect(tightened(state, next)).toEqual(['shelf', 'tray']);
    expect(tightened(state, state)).toEqual([]);
  });

  it('names a removed material attribute, which needs the two-person request', () => {
    expect(removedMaterial(state, removeEntry(state, 0, 1))).toEqual(['origin']);
    expect(removedMaterial(state, removeEntry(state, 1, 0))).toEqual([]);
  });

  it('counts variant attributes and notices an unsaved change', () => {
    const next = addEntry(state, 1, entry('size', { isVariantOption: true }));
    expect(variantCount(next)).toBe(1);
    expect(isDirty(state, next)).toBe(true);
    expect(isDirty(state, fromDetail(detail))).toBe(false);
  });
});
