import { categoryPicker, type PickerNode } from './category-picker';

const n = (
  id: string,
  parentId: string | null,
  position: number,
  status = 'active',
  name = id.toUpperCase(),
): PickerNode => ({ id, parentId, status, position, names: [{ locale: 'en-AU', name }] });

// d > g > c1 (children s1, s2), c2 (leaf), ch (hidden, child sh active), c3 (child sa archived)
const tree: PickerNode[] = [
  n('d', null, 0),
  n('g', 'd', 0),
  n('c2', 'g', 1),
  n('c1', 'g', 0),
  n('s2', 'c1', 1),
  n('s1', 'c1', 0),
  n('ch', 'g', 2, 'hidden'),
  n('sh', 'ch', 0),
  n('c3', 'g', 3),
  n('sa', 'c3', 0, 'archived'),
];

describe('categoryPicker', () => {
  it('lists children first and the parent as General, levels 3 and 4 only, in position order', () => {
    const list = categoryPicker(tree, 'en-AU', 4, false);
    expect(list.map((c) => [c.id, c.general])).toEqual([
      ['s1', false],
      ['s2', false],
      ['c1', true],
      ['c2', false],
      ['c3', false],
    ]);
    expect(list[0]).toMatchObject({ level: 4, path: ['D', 'G', 'C1', 'S1'] });
    expect(list.some((c) => c.level < 3)).toBe(false);
  });
  it('hides hidden nodes and anything under them from a seller, including an active child', () => {
    const ids = categoryPicker(tree, 'en-AU', 4, false).map((c) => c.id);
    expect(ids).not.toContain('ch');
    expect(ids).not.toContain('sh');
  });
  it('shows hidden nodes to an admin', () => {
    const list = categoryPicker(tree, 'en-AU', 4, true);
    expect(list.map((c) => c.id)).toContain('sh');
    expect(list.find((c) => c.id === 'ch')).toMatchObject({ status: 'hidden', general: true });
  });
  it('offers level 3 only where the Market depth is 3 (ZZ)', () => {
    const ids = categoryPicker(tree, 'en-AU', 3, false).map((c) => c.id);
    expect(ids).toEqual(['c1', 'c2', 'c3']);
    expect(categoryPicker(tree, 'en-AU', 3, false).some((c) => c.general)).toBe(false);
  });
  it('falls back to the first name when the locale is missing', () => {
    expect(
      categoryPicker([n('a', null, 0), n('b', 'a', 0), n('c', 'b', 0)], 'fa-IR', 4, false)[0]!.name,
    ).toBe('C');
  });
});
