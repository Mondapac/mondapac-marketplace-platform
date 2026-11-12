import { ok, Temporal } from '@mondapac/shared-kernel';
import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { AttributeDefinitionStore } from '../../src/modules/catalog/application/ports/attribute-definition.store';
import { AttributeCodeTakenError } from '../../src/modules/catalog/application/ports/attribute-definition.store';
import {
  RelaxationAlreadyOpenError,
  type AttributeRelaxationStore,
} from '../../src/modules/catalog/application/ports/attribute-relaxation.store';
import type { AttributeRelaxationRequest } from '../../src/modules/catalog/domain/attribute-relaxation-request';
import type { ClaimTermLocales } from '../../src/modules/catalog/application/ports/claim-term-locales';
import type { ClaimTextMatcher } from '../../src/modules/catalog/application/ports/claim-text-matcher';
import {
  FeatureSetCodeTakenError,
  type FeatureSetStore,
} from '../../src/modules/catalog/application/ports/feature-set.store';
import type { AttributeFamily } from '../../src/modules/catalog/domain/attribute-family';
import type {
  AttributeDefinition,
  AttributeMergeOption,
} from '../../src/modules/catalog/domain/attribute-definition';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';

// In-memory ports of the attribute editor (attributes plan, package A2) for the use-case specs and
// the HTTP tests. The SQL store is proved in test/db/catalog-attribute-editor.db-spec.ts.

/** A store in memory, per Market, with the same version rule as the SQL one. */
export class MemoryAttributeDefinitionStore implements AttributeDefinitionStore {
  readonly rows = new Map<string, AttributeDefinition>();
  readonly authors: { revisionId: string; author: string; relaxationRequestId?: string }[] = [];
  /** Set to make the next write lose a race. */
  raceNext = false;

  reset(): void {
    this.rows.clear();
    this.authors.length = 0;
    this.merges.length = 0;
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

  saveRevision(
    _m: MarketContext,
    definition: AttributeDefinition,
    author: Id<'Account'>,
    relaxationRequestId?: Id<'AttributeRelaxationRequest'>,
  ) {
    this.#check(definition);
    this.authors.push({
      revisionId: definition.state.revisionId,
      author,
      ...(relaxationRequestId === undefined ? {} : { relaxationRequestId }),
    });
    this.rows.set(definition.state.id, definition);
    return Promise.resolve();
  }

  lockAtVersion(market: MarketContext, id: Id<'AttributeDefinition'>, version: number) {
    const row = this.rows.get(id);
    return Promise.resolve(
      row?.state.marketId === market.marketId && row.state.version === version,
    );
  }

  saveStatus(_m: MarketContext, definition: AttributeDefinition) {
    this.#check(definition);
    this.rows.set(definition.state.id, definition);
    return Promise.resolve();
  }

  /** What each merge wrote: the source, its target and the value map. */
  readonly merges: {
    source: string;
    target: string;
    options: readonly AttributeMergeOption[];
  }[] = [];

  hasMergedSources(_m: MarketContext, id: Id<'AttributeDefinition'>) {
    return Promise.resolve(this.merges.some((merge) => merge.target === id));
  }

  saveMerge(
    _m: MarketContext,
    source: AttributeDefinition,
    target: Id<'AttributeDefinition'>,
    options: readonly AttributeMergeOption[],
  ) {
    this.#check(source);
    this.rows.set(source.state.id, source);
    this.merges.push({ source: source.state.id, target, options });
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

/** Feature sets in memory, per Market, with the same version rule as the SQL store. */
export class MemoryFeatureSetStore implements FeatureSetStore {
  readonly rows = new Map<string, AttributeFamily>();
  readonly authors: { revisionId: string; author: string }[] = [];
  /** Set to make the next write lose a race. */
  raceNext = false;

  reset(): void {
    this.rows.clear();
    this.authors.length = 0;
    this.raceNext = false;
  }

  findById(market: MarketContext, id: Id<'AttributeFamily'>) {
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

  addNew(_m: MarketContext, family: AttributeFamily, author: Id<'Account'>) {
    if (this.raceNext) {
      this.raceNext = false;
      return Promise.reject(new FeatureSetCodeTakenError());
    }
    this.rows.set(family.state.id, family);
    this.authors.push({ revisionId: family.state.revisionId, author });
    return Promise.resolve();
  }

  saveRevision(_m: MarketContext, family: AttributeFamily, author: Id<'Account'>) {
    const stored = this.rows.get(family.state.id);
    if (this.raceNext || stored?.state.version !== family.state.version - 1) {
      this.raceNext = false;
      throw new StaleAggregateError('attribute-family', family.state.id);
    }
    this.authors.push({ revisionId: family.state.revisionId, author });
    this.rows.set(family.state.id, family);
    return Promise.resolve();
  }
}

/** Relaxation requests in memory, with the SQL store's one-open and from-open-at-version rules. */
export class MemoryAttributeRelaxationStore implements AttributeRelaxationStore {
  readonly rows = new Map<string, AttributeRelaxationRequest>();

  reset(): void {
    this.rows.clear();
  }

  findById(market: MarketContext, id: Id<'AttributeRelaxationRequest'>) {
    const row = this.rows.get(id);
    return Promise.resolve(row?.state.marketId === market.marketId ? row : null);
  }

  openOf(market: MarketContext, definitionId: Id<'AttributeDefinition'>) {
    return Promise.resolve(
      [...this.rows.values()].find(
        (row) =>
          row.state.marketId === market.marketId &&
          row.state.definitionId === definitionId &&
          row.state.status === 'open',
      ) ?? null,
    );
  }

  async add(market: MarketContext, request: AttributeRelaxationRequest) {
    if ((await this.openOf(market, request.state.definitionId)) !== null) {
      throw new RelaxationAlreadyOpenError();
    }
    this.rows.set(request.state.id, request);
  }

  saveMove(_m: MarketContext, request: AttributeRelaxationRequest) {
    const stored = this.rows.get(request.state.id);
    if (stored?.state.status !== 'open' || stored.state.version !== request.state.version - 1) {
      return Promise.reject(
        new StaleAggregateError('attribute-relaxation-request', request.state.id),
      );
    }
    this.rows.set(request.state.id, request);
    return Promise.resolve();
  }

  #open(market: MarketContext, now: Temporal.Instant, expired: boolean, limit: number) {
    return [...this.rows.values()]
      .filter(
        (row) =>
          row.state.marketId === market.marketId &&
          row.state.status === 'open' &&
          Temporal.Instant.compare(row.state.expiresAt, now) <= 0 === expired,
      )
      .sort(
        (a, b) =>
          Temporal.Instant.compare(a.state.expiresAt, b.state.expiresAt) ||
          a.state.id.localeCompare(b.state.id),
      )
      .slice(0, limit);
  }

  listOpen(market: MarketContext, now: Temporal.Instant, limit: number) {
    return Promise.resolve(this.#open(market, now, false, limit));
  }

  listExpired(market: MarketContext, now: Temporal.Instant, limit: number) {
    return Promise.resolve(this.#open(market, now, true, limit));
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
