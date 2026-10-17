import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { TaxStrategyParams } from '../../domain/strategy';

export interface StrategyRecord {
  readonly id: Id<'TaxStrategy'>;
  readonly name: string;
  readonly params: TaxStrategyParams;
  readonly active: boolean;
  readonly createdAt: Temporal.Instant;
  readonly updatedAt: Temporal.Instant;
}

/**
 * The tax strategies of one Market (`tax.tax_strategies`). At most one is active; with none
 * active the Market's built-in strategy applies. Every method runs inside the caller's unit of
 * work and is scoped by the Market.
 */
export interface StrategyRepository {
  /** Newest first. */
  list(market: MarketContext): Promise<readonly StrategyRecord[]>;
  find(market: MarketContext, id: Id<'TaxStrategy'>): Promise<StrategyRecord | null>;
  findActive(market: MarketContext): Promise<StrategyRecord | null>;

  /**
   * Like `find`, and takes the row's write lock for the rest of the unit, so two admin edits
   * serialise and each audits the value it really replaced.
   */
  findForUpdate(market: MarketContext, id: Id<'TaxStrategy'>): Promise<StrategyRecord | null>;

  insert(
    market: MarketContext,
    record: Omit<StrategyRecord, 'active' | 'updatedAt'> & { readonly updatedBy: Id<'Account'> },
  ): Promise<void>;
  update(
    market: MarketContext,
    record: Pick<StrategyRecord, 'id' | 'name' | 'params' | 'updatedAt'> & {
      readonly updatedBy: Id<'Account'>;
    },
  ): Promise<void>;
  /** Switches the Market's active strategy off, whichever it is; false when none was active. */
  deactivateAll(
    market: MarketContext,
    stamp: { readonly updatedAt: Temporal.Instant; readonly updatedBy: Id<'Account'> },
  ): Promise<boolean>;
  activate(
    market: MarketContext,
    id: Id<'TaxStrategy'>,
    stamp: { readonly updatedAt: Temporal.Instant; readonly updatedBy: Id<'Account'> },
  ): Promise<void>;
  remove(market: MarketContext, id: Id<'TaxStrategy'>): Promise<boolean>;
}

export const STRATEGY_REPOSITORY = Symbol('STRATEGY_REPOSITORY');
