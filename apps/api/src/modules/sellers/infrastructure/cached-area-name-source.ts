import { Logger } from '@nestjs/common';
import { ok } from '@mondapac/shared-kernel';
import type { Clock, MarketContext } from '@mondapac/shared-kernel';
import type { UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import type {
  AreaNameSource,
  EditedNamesByArea,
  ServiceAreaNamesRepository,
} from '../application/ports/service-area-names.repository';

/** How long an answer is kept (ADR-0041 decision 3): another instance shows an old name this long. */
export const AREA_NAMES_TTL_MS = 60_000;

/**
 * {@link AreaNameSource} that reads the edited names in a read-only unit and keeps the answer per
 * Market for a minute. A failed read answers an empty map and is not cached, so the configured
 * names show and the next call tries again.
 */
export class CachedAreaNameSource implements AreaNameSource {
  readonly #logger = new Logger('AreaNameSource');
  readonly #cache = new Map<string, { readonly at: number; readonly names: EditedNamesByArea }>();

  constructor(
    private readonly unitOfWork: UnitOfWork,
    private readonly repository: ServiceAreaNamesRepository,
    private readonly clock: Clock,
  ) {}

  async edited(market: MarketContext): Promise<EditedNamesByArea> {
    const now = this.clock.now().epochMilliseconds;
    const kept = this.#cache.get(market.marketId);
    if (kept !== undefined && now - kept.at < AREA_NAMES_TTL_MS) return kept.names;
    try {
      const rows = await this.unitOfWork.run<readonly { a: string; l: string; n: string }[], never>(
        market,
        async () => {
          const all = await this.repository.all(market);
          return ok(all.map((r) => ({ a: r.areaCode, l: r.locale, n: r.name })));
        },
        { readOnly: true },
      );
      if (!rows.ok) return new Map();
      const byArea = new Map<string, Record<string, string>>();
      for (const row of rows.value) {
        byArea.set(row.a, { ...(byArea.get(row.a) ?? {}), [row.l]: row.n });
      }
      this.#cache.set(market.marketId, { at: now, names: byArea });
      return byArea;
    } catch (error) {
      this.#logger.error({
        msg: 'sellers.area-names.read-failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: market.marketId,
      });
      return new Map();
    }
  }

  forget(market: MarketContext): void {
    this.#cache.delete(market.marketId);
  }
}
