import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import type { CategoryPathsReader } from '../application/ports/category-paths.reader';

/** Deeper than any tree the no-cycle trigger allows (data design 3.4: refused at 64). */
const MAX_DEPTH = 64;

interface Node {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: string;
  readonly mergedIntoId: string | null;
}

/**
 * {@link CategoryPathsReader} on `catalog.platform_categories` (data design 3.4). Reads the nodes
 * it needs level by level (one statement per level, each with `marketId` at the top of `where`),
 * follows a merge to its target and drops an archived category, then builds each path root first.
 * A path that cannot be completed (an unknown or archived ancestor, a merge loop, a depth past the
 * cap) is dropped: a claim is never asked on a path the tree does not hold.
 */
export class PrismaCategoryPathsReader implements CategoryPathsReader {
  constructor(private readonly prisma: PrismaService) {}

  async livePaths(
    market: MarketContext,
    categoryIds: readonly string[],
  ): Promise<readonly (readonly Id<'Category'>[])[]> {
    const tx = this.prisma.tx(market);
    const nodes = new Map<string, Node>();
    const load = async (ids: Iterable<string>): Promise<void> => {
      const missing = [...new Set(ids)].filter((id) => !nodes.has(id));
      if (missing.length === 0) return;
      const rows = await tx.catalogPlatformCategory.findMany({
        where: { marketId: market.marketId, id: { in: missing } },
        select: { id: true, parentId: true, status: true, mergedIntoId: true },
      });
      for (const row of rows) nodes.set(row.id, row);
    };

    // Resolve each named category to its live node: follow merges, drop archived.
    let frontier = [...new Set(categoryIds)];
    const live = new Map<string, string | null>(frontier.map((id) => [id, id]));
    for (let depth = 0; depth < MAX_DEPTH && frontier.length > 0; depth += 1) {
      await load(frontier);
      const next: string[] = [];
      for (const [origin, current] of live) {
        if (current === null) continue;
        const node = nodes.get(current);
        if (node === undefined || node.status === 'archived') live.set(origin, null);
        else if (node.status === 'merged') {
          live.set(origin, node.mergedIntoId);
          if (node.mergedIntoId !== null) next.push(node.mergedIntoId);
        }
      }
      frontier = next;
    }

    // Load every missing ancestor, one level per statement, until each path reaches a node
    // whose parent is loaded or is a root (or an ancestor cannot be found).
    for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
      const needed = new Set<string>();
      for (const start of live.values()) {
        let cursor = start === null ? undefined : nodes.get(start);
        for (let steps = 0; cursor !== undefined && steps < MAX_DEPTH; steps += 1) {
          if (cursor.parentId === null) break;
          const parent = nodes.get(cursor.parentId);
          if (parent === undefined) {
            needed.add(cursor.parentId);
            break;
          }
          cursor = parent;
        }
      }
      if (needed.size === 0) break;
      const before = nodes.size;
      await load(needed);
      if (nodes.size === before) break;
    }

    const paths: Id<'Category'>[][] = [];
    const seen = new Set<string>();
    for (const origin of categoryIds) {
      const start = live.get(origin) ?? null;
      const node = start === null ? undefined : nodes.get(start);
      if (node === undefined || node.status !== 'active') continue;
      const path: string[] = [];
      let cursor: Node | undefined = node;
      while (cursor !== undefined && path.length < MAX_DEPTH) {
        path.unshift(cursor.id);
        if (cursor.parentId === null) break;
        cursor = nodes.get(cursor.parentId);
        if (cursor !== undefined && cursor.status !== 'active') cursor = undefined;
      }
      // Complete only when it reached a root.
      const root = nodes.get(path[0]!);
      if (root === undefined || root.parentId !== null) continue;
      const key = path.join('/');
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(path as Id<'Category'>[]);
    }
    return paths;
  }
}
