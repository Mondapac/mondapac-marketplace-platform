import type { MarketContext } from '@mondapac/shared-kernel';
import { checkLedgerFact, rollUpLedgerDay, type LedgerFact } from '../domain/ledger';
import { marketDayOf } from '../domain/facts';
import { distinctSellerDays } from '../domain/rollup';
import type { LedgerFactStore } from './ports/ledger-fact-store';
import type { LedgerSourceEntry } from './ports/ledger-sources';
import type { MarketZone } from './ports/market-zone';

export interface LedgerRecorderDependencies {
  readonly store: LedgerFactStore;
  readonly zone: MarketZone;
}

/**
 * The one write path of the ledger facts (dashboards v2, phase 1, PR 4): the event worker and the
 * history backfill call it inside their own SERIALIZABLE unit, so two units that touch one seller
 * day conflict (40001, retried) instead of one rollup missing the other's fact (Mojtaba F1 of
 * PR 9, as for the sales facts).
 *
 * Idempotent: a ledger row never changes, so a fact stored already is left as it is and a row read
 * again that differs is a conflict (`ReportingLedgerConflict`). It refuses, before writing, a row
 * in another currency than the Market's and a malformed row (`RangeError`). It then rebuilds the
 * rollup of every seller day the rows fall on, in a fixed order (day, then seller).
 */
export class LedgerRecorder {
  constructor(private readonly deps: LedgerRecorderDependencies) {}

  async record(market: MarketContext, entries: readonly LedgerSourceEntry[]): Promise<number> {
    if (entries.length === 0) return 0;
    const zone = this.deps.zone.zoneOf(market);
    const currency = this.deps.zone.currencyOf(market);
    const facts: LedgerFact[] = entries.map((entry) => ({
      ...entry,
      marketDay: marketDayOf(entry.occurredAt, zone),
    }));
    for (const fact of facts) {
      if (fact.currency !== currency) {
        throw new RangeError(
          `reporting: a ledger row in ${fact.currency} for a Market in ${currency}`,
        );
      }
      checkLedgerFact(fact);
    }
    await this.deps.store.putEntries(market, facts);
    for (const key of distinctSellerDays(
      facts.map((fact) => ({ marketDay: fact.marketDay, sellerId: fact.sellerId })),
    )) {
      const day = await this.deps.store.loadSellerDay(market, key);
      await this.deps.store.replaceSellerDay(market, key, rollUpLedgerDay(day));
    }
    return facts.length;
  }
}
