import type { Id } from '@mondapac/shared-kernel';
import type { EditableCategory } from './category-edit';
import {
  directProductScope,
  featureSetChanges,
  mergedInto,
  planArchive,
  planMerge,
  planMove,
} from './category-restructure';

const cat = (n: number): Id<'Category'> =>
  `01990000-0000-7000-8000-${(0xf00 + n).toString(16).padStart(12, '0')}` as Id<'Category'>;

const node = (
  n: number,
  parent: number | null,
  patch: Partial<EditableCategory> = {},
): EditableCategory => ({
  id: cat(n),
  parentId: parent === null ? null : cat(parent),
  slug: `c${n}`,
  status: 'active',
  hiddenById: null,
  position: n,
  version: 1,
  revisionNo: 1,
  createdByKind: 'admin',
  showInMenu: true,
  imageId: null,
  seo: { title: null, description: null, noindex: false },
  texts: [{ locale: 'en', name: `Category ${n}`, shortDescription: null, keywords: [] }],
  ...patch,
});

/**
 * 1 ─┬─ 2 ─┬─ 3 ── 4
 *    │     └─ 5
 *    └─ 6
 * 7 ─── 8
 */
const tree = (patches: Record<number, Partial<EditableCategory>> = {}): EditableCategory[] =>
  (
    [
      [1, null],
      [2, 1],
      [3, 2],
      [4, 3],
      [5, 2],
      [6, 1],
      [7, null],
      [8, 7],
    ] as const
  ).map(([n, parent]) => node(n, parent, patches[n] ?? {}));

const at = (nodes: readonly EditableCategory[], n: number) =>
  nodes.find((entry) => entry.id === cat(n))!;

const NONE = new Map<string, number>();
const sorted = (ids: readonly string[]) => [...ids].sort();

/** The two Market fixtures: AU allows four levels, the synthetic ZZ three. */
const MARKETS = [
  { market: 'AU', maxDepth: 4 },
  { market: 'ZZ', maxDepth: 3 },
] as const;

describe.each(MARKETS)('category restructure plans ($market)', ({ maxDepth }) => {
  describe('planMove', () => {
    it('moves a level-3 subtree under another group, last among its new siblings', () => {
      const nodes = tree();
      const plan = planMove(nodes, at(nodes, 5), cat(8), maxDepth, NONE);
      expect(plan).toEqual({
        ok: true,
        value: {
          changes: [{ id: cat(5), kind: 'moved', parentId: cat(8), position: 0 }],
          // The moved category, and its old ancestors that are not ancestors after the move.
          retirementCheckIds: [cat(5), cat(2), cat(1)],
          affectedIds: [cat(5)],
          levelBefore: 3,
          levelAfter: 3,
        },
      });
    });

    it('takes the next free position after every child of the new parent, of any status', () => {
      const nodes = [...tree(), node(9, 8, { position: 4, status: 'archived' })];
      const plan = planMove(nodes, at(nodes, 5), cat(8), maxDepth, NONE);
      expect(plan.ok && plan.value.changes[0]).toEqual(
        expect.objectContaining({ id: cat(5), position: 5 }),
      );
    });

    it('keeps the ancestors the category stays under out of the retirement check', () => {
      const nodes = tree();
      const plan = planMove(nodes, at(nodes, 5), cat(6), maxDepth, NONE);
      expect(plan.ok && plan.value.retirementCheckIds).toEqual([cat(5), cat(2)]);
    });

    it('refuses the same parent', () => {
      const nodes = tree();
      expect(planMove(nodes, at(nodes, 3), cat(2), maxDepth, NONE)).toEqual({
        ok: false,
        error: { code: 'category.move-unchanged' },
      });
    });

    it.each([
      ['under itself', 2],
      ['under its own descendant', 4],
    ])('refuses a move %s (cycle)', (_label, parent) => {
      const nodes = tree();
      expect(planMove(nodes, at(nodes, 2), cat(parent), maxDepth, NONE)).toEqual({
        ok: false,
        error: { code: 'category.cycle' },
      });
    });

    it('refuses a parent that is missing, merged or archived', () => {
      const nodes = tree({ 6: { status: 'archived' }, 8: { status: 'merged' } });
      for (const parent of [cat(99), cat(6), cat(8)]) {
        expect(planMove(nodes, at(nodes, 5), parent, maxDepth, NONE)).toEqual({
          ok: false,
          error: { code: 'category.parent-not-found' },
        });
      }
    });

    it('refuses a category that is not live', () => {
      const nodes = tree({ 5: { status: 'archived' } });
      expect(planMove(nodes, at(nodes, 5), cat(8), maxDepth, NONE)).toEqual({
        ok: false,
        error: { code: 'category.not-editable' },
      });
    });

    it("refuses a subtree that would pass the Market's depth", () => {
      // 2 (L2) with 3 (L3) and 4 (L4) under 8 (L2): 4 lands on level 5.
      const nodes = tree();
      expect(planMove(nodes, at(nodes, 2), cat(8), maxDepth, NONE)).toEqual({
        ok: false,
        error: { code: 'category.depth-exceeded', max: maxDepth },
      });
    });

    it("allows exactly the Market's depth and refuses one more", () => {
      // 3 (L3) and 4 (L4) under 6 (L2) keep levels 3 and 4.
      const nodes = tree();
      const plan = planMove(nodes, at(nodes, 3), cat(6), maxDepth, NONE);
      if (maxDepth >= 4) {
        expect(plan.ok).toBe(true);
      } else {
        expect(plan).toEqual({
          ok: false,
          error: { code: 'category.depth-exceeded', max: maxDepth },
        });
      }
    });

    it('refuses a name a new sibling already has, naming the path', () => {
      const nodes = [
        ...tree(),
        node(9, 8, {
          texts: [{ locale: 'en', name: 'Category 5', shortDescription: null, keywords: [] }],
        }),
      ];
      expect(planMove(nodes, at(nodes, 5), cat(8), maxDepth, NONE)).toEqual({
        ok: false,
        error: {
          code: 'category.sibling-name-taken',
          fields: [{ path: 'texts.en.name', code: 'sibling-name-taken' }],
        },
      });
    });

    it('refuses a move that would leave products on level 1 or 2, with their count', () => {
      const nodes = tree();
      const direct = new Map<string, number>([
        [cat(5), 2],
        [cat(4), 7],
      ]);
      // 5 (L3, 2 products) to a department: level 1.
      expect(planMove(nodes, at(nodes, 5), null, maxDepth, direct)).toEqual({
        ok: false,
        error: { code: 'category.products-on-upper-level', total: 2 },
      });
    });

    it('moves an empty category to the top as a department', () => {
      const nodes = tree();
      const plan = planMove(nodes, at(nodes, 6), null, maxDepth, NONE);
      expect(plan.ok).toBe(true);
      if (!plan.ok) return;
      expect(plan.value).toMatchObject({
        changes: [{ id: cat(6), kind: 'moved', parentId: null, position: 8 }],
        retirementCheckIds: [cat(6), cat(1)],
        levelBefore: 2,
        levelAfter: 1,
      });
    });

    it('hides an active subtree that moves under a hidden parent, by that cascade', () => {
      const nodes = tree({ 7: { status: 'hidden' }, 8: { status: 'hidden', hiddenById: cat(7) } });
      const plan = planMove(nodes, at(nodes, 5), cat(8), maxDepth, NONE);
      expect(plan.ok && plan.value.changes).toEqual([
        {
          id: cat(5),
          kind: 'moved',
          parentId: cat(8),
          position: 0,
          status: 'hidden',
          hiddenById: cat(7),
        },
      ]);
    });

    it('never shows a category: one hidden by an outside cascade stays hidden, on its own', () => {
      const nodes = tree({
        2: { status: 'hidden' },
        5: { status: 'hidden', hiddenById: cat(2) },
      });
      const plan = planMove(nodes, at(nodes, 5), cat(8), maxDepth, NONE);
      expect(plan.ok && plan.value.changes).toEqual([
        { id: cat(5), kind: 'moved', parentId: cat(8), position: 0, hiddenById: null },
      ]);
    });

    it('keeps a cascade that starts inside the moved subtree', () => {
      const nodes = tree({
        3: { status: 'hidden' },
        4: { status: 'hidden', hiddenById: cat(3) },
      });
      const plan = planMove(nodes, at(nodes, 3), cat(1), maxDepth, NONE);
      expect(plan.ok && plan.value.changes).toEqual([
        { id: cat(3), kind: 'moved', parentId: cat(1), position: 7 },
      ]);
      expect(plan.ok && sorted(plan.value.affectedIds)).toEqual(sorted([cat(3), cat(4)]));
    });
  });

  describe('planMerge', () => {
    it("moves the source's children under the target and marks the source merged", () => {
      const nodes = tree();
      const planned = planMerge(nodes, at(nodes, 2), cat(6), maxDepth, NONE);
      const plan = planned.ok
        ? { ok: true, value: { ...planned.value, affectedIds: sorted(planned.value.affectedIds) } }
        : planned;
      if (maxDepth < 4) {
        // 4 stays on level 4 under 6, so ZZ refuses it.
        expect(plan).toEqual({
          ok: false,
          error: { code: 'category.depth-exceeded', max: maxDepth },
        });
        return;
      }
      expect(plan).toEqual({
        ok: true,
        value: {
          changes: [
            {
              id: cat(2),
              kind: 'merged',
              status: 'merged',
              hiddenById: null,
              mergedIntoId: cat(6),
            },
            { id: cat(3), kind: 'moved', parentId: cat(6), position: 0 },
            { id: cat(5), kind: 'moved', parentId: cat(6), position: 1 },
          ],
          retirementCheckIds: [cat(2)],
          affectedIds: sorted([cat(2), cat(3), cat(4), cat(5)]),
          levelBefore: 2,
          levelAfter: 2,
        },
      });
    });

    it('checks the source and its ancestors that are not the target’s', () => {
      const nodes = tree();
      const plan = planMerge(nodes, at(nodes, 5), cat(8), maxDepth, NONE);
      expect(plan.ok && plan.value.retirementCheckIds).toEqual([cat(5), cat(2), cat(1)]);
    });

    it.each([
      ['into itself', 2],
      ['into its own descendant', 3],
    ])('refuses a merge %s (cycle)', (_label, target) => {
      const nodes = tree();
      expect(planMerge(nodes, at(nodes, 2), cat(target), maxDepth, NONE)).toEqual({
        ok: false,
        error: { code: 'category.cycle' },
      });
    });

    it('refuses a target that is missing or not live', () => {
      const nodes = tree({ 8: { status: 'archived' } });
      for (const target of [cat(99), cat(8)]) {
        expect(planMerge(nodes, at(nodes, 5), target, maxDepth, NONE)).toEqual({
          ok: false,
          error: { code: 'category.target-not-found' },
        });
      }
    });

    it('refuses a child whose name the target already has, naming the child', () => {
      const nodes = [
        ...tree(),
        node(9, 6, {
          texts: [{ locale: 'en', name: 'Category 5', shortDescription: null, keywords: [] }],
        }),
      ];
      const plan = planMerge(nodes, at(nodes, 2), cat(6), maxDepth, NONE);
      if (maxDepth < 4) return; // ZZ refuses on depth first.
      expect(plan).toEqual({
        ok: false,
        error: {
          code: 'category.sibling-name-taken',
          fields: [{ path: `children.${cat(5)}.texts.en.name`, code: 'sibling-name-taken' }],
        },
      });
    });

    it("refuses when the source's products would land on level 1", () => {
      const nodes = tree();
      expect(planMerge(nodes, at(nodes, 8), cat(1), maxDepth, new Map([[cat(8), 3]]))).toEqual({
        ok: false,
        error: { code: 'category.products-on-upper-level', total: 3 },
      });
    });

    it('refuses a subtree that would pass the depth under a deeper target', () => {
      const nodes = tree();
      expect(planMerge(nodes, at(nodes, 1), cat(8), maxDepth, NONE)).toEqual({
        ok: false,
        error: { code: 'category.depth-exceeded', max: maxDepth },
      });
    });
  });

  describe('rows merged into the changed categories (Hassan H1)', () => {
    // 9 merged into 5 (level 3), 11 merged into 9; 12 merged into 8 (outside).
    const withMerged = () => [
      ...tree(),
      node(9, 7, { status: 'merged', mergedIntoId: cat(5) }),
      node(11, 7, { status: 'merged', mergedIntoId: cat(9) }),
      node(12, 1, { status: 'merged', mergedIntoId: cat(8) }),
    ];

    it('finds the rows whose merge chain ends in the ids', () => {
      const nodes = withMerged();
      expect(mergedInto(nodes, [cat(5)])).toEqual([cat(9), cat(11)]);
      expect(mergedInto(nodes, [cat(3)])).toEqual([]);
      expect(directProductScope(nodes, at(nodes, 5))).toEqual([cat(5), cat(9), cat(11)]);
      expect(directProductScope(nodes, at(nodes, 3))).toEqual([cat(3), cat(4)]);
    });

    it('a move marks and checks them with the moved category', () => {
      const nodes = withMerged();
      expect(planMove(nodes, at(nodes, 5), cat(6), maxDepth, NONE)).toMatchObject({
        ok: true,
        value: {
          affectedIds: [cat(5), cat(9), cat(11)],
          retirementCheckIds: [cat(5), cat(9), cat(11), cat(2)],
        },
      });
    });

    it('a move counts their products at the level they resolve to', () => {
      // 5 under 7 lands on level 2: products of 11 resolve to 5; those of 12 stay on 8.
      const nodes = withMerged();
      expect(planMove(nodes, at(nodes, 5), cat(7), maxDepth, new Map([[cat(11), 2]]))).toEqual({
        ok: false,
        error: { code: 'category.products-on-upper-level', total: 2 },
      });
      expect(planMove(nodes, at(nodes, 5), cat(7), maxDepth, new Map([[cat(12), 2]])).ok).toBe(
        true,
      );
    });

    it('a merge marks and checks the rows merged into the source', () => {
      const nodes = withMerged();
      expect(planMerge(nodes, at(nodes, 5), cat(3), maxDepth, NONE)).toMatchObject({
        ok: true,
        value: {
          affectedIds: [cat(5), cat(9), cat(11)],
          retirementCheckIds: [cat(5), cat(9), cat(11)],
        },
      });
    });
  });

  describe('planArchive', () => {
    it('archives a leaf and checks only that category', () => {
      const nodes = tree();
      expect(planArchive(nodes, at(nodes, 4), [])).toEqual({
        ok: true,
        value: {
          changes: [{ id: cat(4), kind: 'archived', status: 'archived', hiddenById: null }],
          retirementCheckIds: [cat(4)],
          affectedIds: [cat(4)],
          levelBefore: 4,
          levelAfter: 4,
        },
      });
    });

    it('refuses a category with a live subcategory', () => {
      const nodes = tree();
      expect(planArchive(nodes, at(nodes, 3), [])).toEqual({
        ok: false,
        error: { code: 'category.has-subcategories' },
      });
    });

    it('allows a category whose only subcategories are archived or merged', () => {
      const nodes = tree({ 4: { status: 'archived' } });
      expect(planArchive(nodes, at(nodes, 3), []).ok).toBe(true);
    });

    it('refuses while a published product has no other live platform category', () => {
      // One product names only 5; another names 5 and 9, which is archived.
      const nodes = [...tree(), node(9, 8, { status: 'archived' })];
      expect(planArchive(nodes, at(nodes, 5), [[], [cat(9)]])).toEqual({
        ok: false,
        error: { code: 'category.only-platform-category', total: 2 },
      });
    });

    it('checks the ancestors a product leaves, and not the ones its other category keeps (M1)', () => {
      // 1 ─┬─ 2 ─┬─ 3 ── 4 / 5;  10 under 2 (a sibling of 5);  8 under 7.
      const nodes = [...tree(), node(10, 2)];
      // On 5 and 10: 2 and 1 stay on its path, nothing leaves.
      expect(planArchive(nodes, at(nodes, 5), [[cat(10)]])).toMatchObject({
        ok: true,
        value: { retirementCheckIds: [cat(5)] },
      });
      // On 5 and 8: 2 and 1 leave its path.
      expect(planArchive(nodes, at(nodes, 5), [[cat(10)], [cat(8)]])).toMatchObject({
        ok: true,
        value: { retirementCheckIds: [cat(5), cat(2), cat(1)] },
      });
      // On 5 and 6 (under 1): only 2 leaves.
      expect(planArchive(nodes, at(nodes, 5), [[cat(6)]])).toMatchObject({
        ok: true,
        value: { retirementCheckIds: [cat(5), cat(2)] },
      });
    });

    it('retires the rows merged into it, and counts their products (H1)', () => {
      // 9 was merged into 5, and 11 into 9: both resolve to 5.
      const nodes = [
        ...tree(),
        node(9, 2, { status: 'merged', mergedIntoId: cat(5) }),
        node(11, 8, { status: 'merged', mergedIntoId: cat(9) }),
      ];
      expect(planArchive(nodes, at(nodes, 5), [[cat(6)]])).toMatchObject({
        ok: true,
        value: {
          retirementCheckIds: [cat(5), cat(9), cat(11), cat(2)],
          affectedIds: [cat(5), cat(9), cat(11)],
        },
      });
      // A product whose other category is a row merged into 5 has no live category left.
      expect(planArchive(nodes, at(nodes, 5), [[cat(11)]])).toEqual({
        ok: false,
        error: { code: 'category.only-platform-category', total: 1 },
      });
      // A row merged into a live category elsewhere keeps the product live.
      const elsewhere = [...nodes, node(12, 7, { status: 'merged', mergedIntoId: cat(8) })];
      expect(planArchive(elsewhere, at(elsewhere, 5), [[cat(12)]]).ok).toBe(true);
    });

    it('refuses a category that is already archived', () => {
      const nodes = tree({ 5: { status: 'archived' } });
      expect(planArchive(nodes, at(nodes, 5), [])).toEqual({
        ok: false,
        error: { code: 'category.not-editable' },
      });
    });
  });
});

describe('featureSetChanges', () => {
  // A ─┬─ B ── C        families: A holds fa, D holds fd, C holds fc
  //    └─ D ── E
  const edges = [
    { id: 'A', parentId: null },
    { id: 'B', parentId: 'A' },
    { id: 'C', parentId: 'B' },
    { id: 'D', parentId: 'A' },
    { id: 'E', parentId: 'D' },
    { id: 'X', parentId: null },
  ];
  const families: Record<string, string> = { A: 'fa', D: 'fd', C: 'fc' };
  const familyOf = (id: string) => families[id];

  it('counts products whose inherited feature set changes with a move, once each', () => {
    const facts = [
      { categoryIds: ['B'] }, // fa -> fd
      { categoryIds: ['C'] }, // holds its own fc: unchanged
      { categoryIds: ['B', 'C'] }, // B changes: counted once
      { categoryIds: ['E'] }, // outside the moved subtree
    ];
    expect(featureSetChanges(edges, 'B', 'move', 'D', familyOf, facts)).toBe(2);
  });

  it('counts none when the new parent gives the same feature set', () => {
    expect(featureSetChanges(edges, 'E', 'move', 'D', familyOf, [{ categoryIds: ['E'] }])).toBe(0);
  });

  it('a move to the top leaves a category with no feature set unless it holds one', () => {
    const facts = [{ categoryIds: ['B'] }, { categoryIds: ['C'] }];
    expect(featureSetChanges(edges, 'B', 'move', null, familyOf, facts)).toBe(1);
  });

  it("a merge gives the source's products the target's feature set and its children the target's chain", () => {
    const facts = [
      { categoryIds: ['B'] }, // now on D: fd
      { categoryIds: ['C'] }, // own fc
      { categoryIds: ['X'] }, // elsewhere
    ];
    expect(featureSetChanges(edges, 'B', 'merge', 'D', familyOf, facts)).toBe(1);
    expect(featureSetChanges(edges, 'D', 'merge', 'B', familyOf, [{ categoryIds: ['E'] }])).toBe(1);
  });
});
