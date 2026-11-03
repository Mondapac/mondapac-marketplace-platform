import type { Id, MarketContext } from '@mondapac/shared-kernel';
import { ok } from '@mondapac/shared-kernel';
import type { AttributeDefinitionStore } from '../../src/modules/catalog/application/ports/attribute-definition.store';
import { AttributeCodeTakenError } from '../../src/modules/catalog/application/ports/attribute-definition.store';
import type { ClaimTermLocales } from '../../src/modules/catalog/application/ports/claim-term-locales';
import type { ClaimTextMatcher } from '../../src/modules/catalog/application/ports/claim-text-matcher';
import type { AttributeDefinition } from '../../src/modules/catalog/domain/attribute-definition';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

// In-memory ports of the attribute editor (attributes plan, package A2) for the use-case specs and
// the HTTP tests. The SQL store is proved in test/db/catalog-attribute-editor.db-spec.ts.

/** A store in memory, per Market, with the same version rule as the SQL one. */
export class MemoryAttributeDefinitionStore implements AttributeDefinitionStore {
  readonly rows = new Map<string, AttributeDefinition>();
  readonly authors: { revisionId: string; author: string }[] = [];
  /** Set to make the next write lose a race. */
  raceNext = false;

  reset(): void {
    this.rows.clear();
    this.authors.length = 0;
    this.raceNext = false;
  }

  findById(market: MarketContext, id: Id<'AttributeDefinition'>) {
    const row = this.rows.get(id);
    return Promise.resolve(row?.state.marketId === market.marketId ? row : null);
  }

  codeTaken(market: MarketContext, code: string) {
    return Promise.resolve(
      [...this.rows.values()].some(
        (row) => row.state.marketId === market.marketId && row.state.code === code,
      ),
    );
  }

  addDraft(_m: MarketContext, definition: AttributeDefinition, author: Id<'Account'>) {
    if (this.raceNext) {
      this.raceNext = false;
      return Promise.reject(new AttributeCodeTakenError());
    }
    this.rows.set(definition.state.id, definition);
    this.authors.push({ revisionId: definition.state.revisionId, author });
    return Promise.resolve();
  }

  saveRevision(_m: MarketContext, definition: AttributeDefinition, author: Id<'Account'>) {
    this.#check(definition);
    this.authors.push({ revisionId: definition.state.revisionId, author });
    this.rows.set(definition.state.id, definition);
    return Promise.resolve();
  }

  saveStatus(_m: MarketContext, definition: AttributeDefinition) {
    this.#check(definition);
    this.rows.set(definition.state.id, definition);
    return Promise.resolve();
  }

  #check(definition: AttributeDefinition): void {
    const stored = this.rows.get(definition.state.id);
    if (this.raceNext || stored?.state.version !== definition.state.version - 1) {
      this.raceNext = false;
      throw new StaleAggregateError('attribute-definition', definition.state.id);
    }
  }
}

/** A matcher that finds the one word `halal`, in any case, and nothing else. */
export const halalOnlyMatcher: ClaimTextMatcher = {
  match: (_context, texts) =>
    Promise.resolve(
      ok(
        texts.map((t) =>
          /halal/i.test(t.text) ? [{ typeCode: 'halal', span: { fromToken: 0, toToken: 0 } }] : [],
        ),
      ),
    ),
};

/** Claim terms in exactly these locales. */
export const claimLocalesOf = (locales: readonly string[]): ClaimTermLocales => ({
  covered: () => Promise.resolve(ok([...locales])),
});
