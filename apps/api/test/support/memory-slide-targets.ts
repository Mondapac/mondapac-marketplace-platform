import type { CallContext } from '@mondapac/shared-kernel';
import {
  targetKey,
  type SlideTarget,
  type SlideTargetType,
  type SlideTargets,
} from '../../src/modules/storefront/application/ports/slide-targets';

/**
 * The things a slide may point at, per Market: what the public catalog and sellers facades would
 * answer. A target registered in one Market is not live in another.
 */
export class MemoryTargets implements SlideTargets {
  private readonly known = new Set<string>();
  /** When true the facades "fail": the answer is null and approval must refuse. */
  unavailable = false;

  add(marketId: string, type: SlideTargetType, id: string): void {
    this.known.add(`${marketId}|${targetKey({ type, id })}`);
  }

  live(context: CallContext, targets: readonly SlideTarget[]): Promise<ReadonlySet<string> | null> {
    if (this.unavailable) return Promise.resolve(null);
    return Promise.resolve(
      new Set(
        targets.map(targetKey).filter((key) => this.known.has(`${context.market.marketId}|${key}`)),
      ),
    );
  }
}
