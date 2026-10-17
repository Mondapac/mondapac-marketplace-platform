import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { PrismaService } from '../../../platform/persistence/prisma.service';
import {
  CategoryPathsUnavailableError,
  type CategoryPathsReader,
} from '../application/ports/category-paths.reader';

/** Deeper than any tree the no-cycle trigger allows (data design 3.4: refused at 64). */
const MAX_DEPTH = 64;
/** Steps one path may take: each level, plus a merge hop per level. */
const MAX_STEPS = MAX_DEPTH * 2;

interface Node {
  readonly id: string;
  readonly parentId: string | null;
  readonly status: string;
  readonly mergedIntoId: string | null;
}

/** One path being built: the next id to visit, the ids kept so far (leaf first), steps taken. */
interface Walk {
  readonly origin: string;
  next: string | null;
  readonly kept: string[];
  steps: number;
  /** True while the walk is still at the named category (an archived one gives no path). */
  atLeaf: boolean;
  dropped: boolean;
}

/**
 * {@link CategoryPathsReader} on `catalog.platform_categories` (data design 3.4). Every walk
 * starts at a named category and climbs to a root; the nodes a round needs are read in one
 * statement (`marketId` at the top of `where`). A merged node is replaced by its target, an
 * archived ancestor is skipped and an archived named category drops its path. Anything that
 * cannot be resolved throws {@link CategoryPathsUnavailableError} (fail closed, Hassan M3).
 */
export class PrismaCategoryPathsReader implements CategoryPathsReader {
  constructor(private readonly prisma: PrismaService) {}

  async livePaths(
    market: MarketContext,
    categoryIds: readonly string[],
  ): Promise<readonly (readonly Id<'Category'>[])[]> {
    const tx = this.prisma.tx(market);
    const nodes = new Map<string, Node>();
    const walks: Walk[] = categoryIds.map((origin) => ({
      origin,
      next: origin,
      kept: [],
      steps: 0,
      atLeaf: true,
      dropped: false,
    }));

    for (let round = 0; ; round += 1) {
      if (round > MAX_STEPS) throw new CategoryPathsUnavailableError('too deep');
      const missing = new Set<string>();
      for (const walk of walks) {
        while (walk.next !== null && !walk.dropped) {
          const node = nodes.get(walk.next);
          if (node === undefined) {
            missing.add(walk.next);
            break;
          }
          walk.steps += 1;
          if (walk.steps > MAX_STEPS) throw new CategoryPathsUnavailableError('loop');
          if (node.status === 'merged') {
            if (node.mergedIntoId === null) throw new CategoryPathsUnavailableError('merge');
            walk.next = node.mergedIntoId;
            continue;
          }
          if (node.status === 'archived') {
            if (walk.atLeaf) {
              walk.dropped = true;
              break;
            }
            walk.next = node.parentId;
            continue;
          }
          if (node.status !== 'active') throw new CategoryPathsUnavailableError('status');
          if (walk.kept.includes(node.id)) throw new CategoryPathsUnavailableError('loop');
          walk.kept.push(node.id);
          walk.atLeaf = false;
          walk.next = node.parentId;
        }
      }
      if (missing.size === 0) break;
      const rows = await tx.catalogPlatformCategory.findMany({
        where: { marketId: market.marketId, id: { in: [...missing] } },
        select: { id: true, parentId: true, status: true, mergedIntoId: true },
      });
      for (const row of rows) nodes.set(row.id, row);
      // A category this Market does not hold: the path cannot be built.
      if (rows.length !== missing.size) throw new CategoryPathsUnavailableError('unknown');
    }

    const paths: Id<'Category'>[][] = [];
    const seen = new Set<string>();
    for (const walk of walks) {
      if (walk.dropped || walk.kept.length === 0) continue;
      const path = [...walk.kept].reverse();
      const key = path.join('/');
      if (seen.has(key)) continue;
      seen.add(key);
      paths.push(path as Id<'Category'>[]);
    }
    return paths;
  }
}
