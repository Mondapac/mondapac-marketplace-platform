import { describe, expect, it } from 'vitest';
import { page, placement } from '../pages/test-data.ts';
import {
  blankItem,
  draftOf,
  errorKey,
  mapProblems,
  moved,
  requestOf,
  sameDraft,
  validate,
  type NavDraft,
} from './nav-form.ts';

const CAT = '0190a000-0000-7000-8000-0000000000d1';
const PAGE = '0190a000-0000-7000-8000-0000000000d2';

const nav = page({
  id: null,
  kind: 'system',
  systemKey: 'navigation',
  draft: {
    versionNo: 2,
    updatedAt: '2026-11-02T02:00:00Z',
    settings: null,
    placements: {
      rail: [
        placement({
          id: 'r1',
          module: 'nav-link',
          config: { label: 'Offers', icon: 'tax', target: { kind: 'path', path: '/offers' } },
        }),
        placement({
          id: 'r2',
          module: 'nav-link',
          enabled: false,
          config: { label: 'Meat', target: { kind: 'category', id: CAT } },
        }),
        placement({
          id: 'r3',
          module: 'nav-link',
          config: { label: 'Ramadan', target: { kind: 'page', id: PAGE } },
        }),
        placement({
          id: 'r4',
          module: 'nav-link',
          config: { label: 'Cart', target: { kind: 'system-page', key: 'cart' } },
        }),
      ],
      'drawer-popular': [
        placement({ id: 'p1', module: 'nav-category', config: { categoryId: CAT, label: 'Meat' } }),
      ],
      'drawer-categories': [],
    },
  },
});

describe('draftOf and requestOf', () => {
  it('reads the four kinds of target and the Browse entries into rows', () => {
    const draft = draftOf(nav);
    expect(draft.rail.map((row) => [row.kind, row.value, row.enabled])).toEqual([
      ['path', '/offers', true],
      ['category', CAT, false],
      ['page', PAGE, true],
      ['system-page', 'cart', true],
    ]);
    expect(draft['drawer-popular'][0]).toMatchObject({ categoryId: CAT, label: 'Meat' });
    expect(draft['drawer-categories']).toEqual([]);
  });

  it('sends back what it read, with every slot, in order', () => {
    expect(requestOf(draftOf(nav))).toEqual({
      slots: {
        rail: [
          {
            config: { label: 'Offers', icon: 'tax', target: { kind: 'path', path: '/offers' } },
            enabled: true,
          },
          { config: { label: 'Meat', target: { kind: 'category', id: CAT } }, enabled: false },
          { config: { label: 'Ramadan', target: { kind: 'page', id: PAGE } }, enabled: true },
          {
            config: { label: 'Cart', target: { kind: 'system-page', key: 'cart' } },
            enabled: true,
          },
        ],
        'drawer-popular': [{ config: { categoryId: CAT, label: 'Meat' }, enabled: true }],
        'drawer-categories': [],
      },
    });
  });

  it('trims texts and leaves out a blank icon and a blank label of a category', () => {
    const draft: NavDraft = {
      rail: [{ ...blankItem('rail'), label: ' Deals ', icon: ' ', value: ' /deals ' }],
      'drawer-popular': [],
      'drawer-categories': [{ ...blankItem('drawer-categories'), categoryId: CAT, label: '  ' }],
    };
    const body = requestOf(draft).slots;
    expect(body.rail).toEqual([
      { config: { label: 'Deals', target: { kind: 'path', path: '/deals' } }, enabled: true },
    ]);
    expect(body['drawer-categories']).toEqual([{ config: { categoryId: CAT }, enabled: true }]);
  });

  it('knows an unchanged draft from a changed one', () => {
    const a = draftOf(nav);
    expect(sameDraft(a, draftOf(nav))).toBe(true);
    expect(sameDraft(a, { ...a, rail: moved(a.rail, 0, 1) })).toBe(false);
    expect(sameDraft(a, { ...a, rail: a.rail.slice(1) })).toBe(false);
  });
});

describe('validate', () => {
  it('asks for a label and a target of a menu item and a category of a Browse entry', () => {
    const errors = validate({
      rail: [blankItem('rail')],
      'drawer-popular': [blankItem('drawer-popular')],
      'drawer-categories': [],
    });
    expect(errors).toEqual({
      [errorKey('rail', 0, 'label')]: 'required',
      [errorKey('rail', 0, 'value')]: 'required',
      [errorKey('drawer-popular', 0, 'categoryId')]: 'required',
    });
  });

  it('checks the label length, the icon and a site path the way the API does', () => {
    const base = blankItem('rail');
    const errors = validate({
      rail: [
        { ...base, label: 'x'.repeat(41), icon: 'Big Icon', value: 'offers' },
        { ...base, label: 'ok', value: '//evil.test' },
        { ...base, label: 'ok', value: '/ok', icon: 'delivery' },
      ],
      'drawer-popular': [
        { ...blankItem('drawer-popular'), categoryId: CAT, label: 'y'.repeat(41) },
      ],
      'drawer-categories': [],
    });
    expect(errors).toEqual({
      [errorKey('rail', 0, 'label')]: 'too-long',
      [errorKey('rail', 0, 'icon')]: 'format',
      [errorKey('rail', 0, 'value')]: 'format',
      [errorKey('rail', 1, 'value')]: 'format',
      [errorKey('drawer-popular', 0, 'label')]: 'too-long',
    });
  });

  it('accepts what it read from the API', () => {
    expect(validate(draftOf(nav))).toEqual({});
  });
});

describe('mapProblems', () => {
  it('puts a refusal on the row the person sees and keeps the rest as other', () => {
    const { rows, other } = mapProblems([
      { path: 'slots.rail[1].config.label', code: 'required' },
      { path: 'slots.rail[1].config.target.path', code: 'format' },
      { path: 'slots.rail[0].config.icon', code: 'format' },
      { path: 'slots.drawer-categories[2].config.categoryId', code: 'uuid' },
      { path: 'slots.drawer-popular[0].config.label', code: 'length' },
      { path: 'slots.rail', code: 'count' },
      { path: 'slots', code: 'type' },
    ]);
    expect(rows).toEqual({
      [errorKey('rail', 1, 'label')]: 'required',
      [errorKey('rail', 1, 'value')]: 'format',
      [errorKey('rail', 0, 'icon')]: 'format',
      [errorKey('drawer-categories', 2, 'categoryId')]: 'invalid',
      [errorKey('drawer-popular', 0, 'label')]: 'too-long',
    });
    expect(other).toEqual(['slots.rail:count', 'slots:type']);
  });
});

describe('moved', () => {
  it('swaps with the neighbour and stays put at the ends', () => {
    expect(moved([1, 2, 3], 1, -1)).toEqual([2, 1, 3]);
    expect(moved([1, 2, 3], 0, -1)).toEqual([1, 2, 3]);
    expect(moved([1, 2, 3], 2, 1)).toEqual([1, 2, 3]);
  });
});
