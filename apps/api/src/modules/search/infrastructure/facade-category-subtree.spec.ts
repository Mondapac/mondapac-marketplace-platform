import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import { testCallContext, testMarketContext } from '@mondapac/shared-kernel/testing';
import type { AssistantCategory, CatalogAssistantFacade } from '../../catalog';
import { categorySubtree, MAX_FILTER_CATEGORIES } from '../domain/category-subtree';
import { FacadeCategorySubtree } from './facade-category-subtree';

// What a category filter covers: the asked category, then every live category under it, read from
// catalog's public tree with the request's context unchanged. A refusal or failure is `null`, so
// the caller fails closed; a category outside the live tree is itself alone.

const category = (n: number) =>
  `01990000-0000-7000-8000-${n.toString(16).padStart(12, '0')}` as Id<'Category'>;
const node = (n: number, parent: number | null, depth = 0): AssistantCategory => ({
  id: category(n),
  parentId: parent === null ? null : category(parent),
  slug: `c-${n}`,
  name: `Category ${n}`,
  depth,
});

// pantry (1) > pasta (2) > fresh pasta (4); pantry > rice (3); bakery (5) on its own.
const TREE = [node(1, null), node(2, 1, 1), node(4, 2, 2), node(3, 1, 1), node(5, null)];

describe('categorySubtree', () => {
  it('names the category first, then every category under it, breadth first', () => {
    expect(categorySubtree(TREE, category(1))).toEqual([
      category(1),
      category(2),
      category(3),
      category(4),
    ]);
    expect(categorySubtree(TREE, category(2))).toEqual([category(2), category(4)]);
  });

  it('is the category alone for a leaf, or for one the live tree does not hold', () => {
    expect(categorySubtree(TREE, category(5))).toEqual([category(5)]);
    expect(categorySubtree(TREE, category(99))).toEqual([category(99)]);
  });

  it('never loops on a bad tree and never names a category twice', () => {
    const looped = [node(1, 2), node(2, 1)];
    expect(categorySubtree(looped, category(1))).toEqual([category(1), category(2)]);
  });

  it('refuses a subtree larger than the filter cap, never a partial one', () => {
    const wide = (children: number) => [
      node(1, null),
      ...Array.from({ length: children }, (_, i) => node(0x100 + i, 1, 1)),
    ];
    expect(categorySubtree(wide(MAX_FILTER_CATEGORIES - 1), category(1))).toHaveLength(
      MAX_FILTER_CATEGORIES,
    );
    expect(categorySubtree(wide(MAX_FILTER_CATEGORIES), category(1))).toBeNull();
  });
});

describe.each(['AU', 'ZZ'])('FacadeCategorySubtree in market %s', (code) => {
  const context: CallContext = testCallContext(testMarketContext(code, 'default'), 'anonymous');

  const facade = (categories: CatalogAssistantFacade['categories']) => {
    const seen: CallContext[] = [];
    const catalog: CatalogAssistantFacade = {
      categories: (asked) => {
        seen.push(asked);
        return categories(asked);
      },
    };
    return { source: new FacadeCategorySubtree(catalog), seen };
  };

  it("reads catalog's live tree with the request's context unchanged", async () => {
    const { source, seen } = facade(() => Promise.resolve(ok(TREE)));

    expect(await source.subtreeOf(context, category(2))).toEqual([category(2), category(4)]);
    expect(seen).toEqual([context]);
  });

  it('is null when catalog refuses or fails', async () => {
    const refused = facade(() => Promise.resolve(err({ code: 'catalog.categories-unavailable' })));
    const thrown = facade(() => Promise.reject(new Error('down')));

    expect(await refused.source.subtreeOf(context, category(1))).toBeNull();
    expect(await thrown.source.subtreeOf(context, category(1))).toBeNull();
  });
});
