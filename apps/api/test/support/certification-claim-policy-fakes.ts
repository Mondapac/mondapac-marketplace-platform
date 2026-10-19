import type { Id, MarketContext, Result } from '@mondapac/shared-kernel';
import type { CatalogReferences } from '../../src/modules/certification/application/ports/catalog-references';
import type {
  ClaimPolicyRepository,
  NewPolicyRevision,
  PolicyRevisionSummary,
  StoredPolicy,
  StoredPolicyRevision,
} from '../../src/modules/certification/application/ports/claim-policy.repository';
import { canonical } from '../../src/modules/certification/domain/claim-policy';
import { StaleAggregateError } from '../../src/platform/unit-of-work/errors';
import type { UnitOfWork } from '../../src/platform/unit-of-work/unit-of-work';
import type { MemoryRegistry } from './certification-registry-fakes';
import { fakeRunOnce } from './fake-run-once';

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface State {
  policies: Map<string, Mutable<StoredPolicy> & { marketId: string }>;
  revisions: Map<string, StoredPolicyRevision & { marketId: string }>;
}

const copyState = (s: State): State => ({
  policies: new Map([...s.policies].map(([k, v]) => [k, { ...v }])),
  revisions: new Map(s.revisions),
});

/**
 * The claim basis policy store in memory (certification slice 13), with the contract of the SQL
 * repository: one policy per Market and type, revision numbers per policy, a moved version throws
 * `StaleAggregateError`. {@link unitOfWork} rolls back this store and the registry together, as
 * one transaction does. The SQL is in test/db/certification-claim-policy.db-spec.ts.
 */
export class MemoryClaimPolicies implements ClaimPolicyRepository {
  state: State = { policies: new Map(), revisions: new Map() };
  /** Called once before the next lock: a test commits a concurrent change here. */
  beforeLock: (() => void) | null = null;

  readonly unitOfWork: UnitOfWork;

  constructor(registry: MemoryRegistry) {
    this.unitOfWork = {
      run: async <T, E>(
        market: MarketContext,
        work: () => Promise<Result<T, E>>,
      ): Promise<Result<T, E>> => {
        const before = copyState(this.state);
        try {
          const result = await registry.unitOfWork.run(market, work);
          if (!result.ok) this.state = before;
          return result;
        } catch (error) {
          this.state = before;
          throw error;
        }
      },
      runOnce: fakeRunOnce(registry.handled),
    };
  }

  private strip<T extends { marketId: string }>(row: T): Omit<T, 'marketId'> {
    const rest: Partial<T> = { ...row };
    delete rest.marketId;
    return rest as Omit<T, 'marketId'>;
  }

  policyOfType(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
  ): Promise<StoredPolicy | null> {
    const row = [...this.state.policies.values()].find(
      (p) => p.marketId === market.marketId && p.typeId === typeId,
    );
    return Promise.resolve(row === undefined ? null : this.strip(row));
  }

  addPolicy(
    market: MarketContext,
    policy: Parameters<ClaimPolicyRepository['addPolicy']>[1],
  ): Promise<void> {
    if (
      [...this.state.policies.values()].some(
        (p) => p.marketId === market.marketId && p.typeId === policy.typeId,
      )
    ) {
      throw new StaleAggregateError('claim-policy', policy.typeId);
    }
    this.state.policies.set(policy.id, {
      marketId: market.marketId,
      id: policy.id,
      typeId: policy.typeId,
      publishedRevisionId: null,
      version: 1,
    });
    return Promise.resolve();
  }

  private at(market: MarketContext, policyId: string, expectedVersion: number) {
    const row = this.state.policies.get(policyId);
    if (row === undefined || row.marketId !== market.marketId || row.version !== expectedVersion) {
      throw new StaleAggregateError('claim-policy', policyId);
    }
    return row;
  }

  lockPolicy(
    market: MarketContext,
    policyId: Id<'ClaimBasisPolicy'>,
    expectedVersion: number,
  ): Promise<void> {
    const hook = this.beforeLock;
    this.beforeLock = null;
    hook?.();
    this.at(market, policyId, expectedVersion);
    return Promise.resolve();
  }

  revision(
    market: MarketContext,
    revisionId: Id<'ClaimPolicyRevision'>,
  ): Promise<StoredPolicyRevision | null> {
    const row = this.state.revisions.get(revisionId);
    return Promise.resolve(
      row === undefined || row.marketId !== market.marketId ? null : this.strip(row),
    );
  }

  revisions(
    market: MarketContext,
    policyId: Id<'ClaimBasisPolicy'>,
    limit: number,
  ): Promise<readonly PolicyRevisionSummary[]> {
    return Promise.resolve(
      [...this.state.revisions.values()]
        .filter((r) => r.marketId === market.marketId && r.policyId === policyId)
        .sort((a, b) => b.revisionNo - a.revisionNo)
        .slice(0, limit)
        .map((r) => ({
          id: r.id,
          revisionNo: r.revisionNo,
          authorAccountId: r.authorAccountId,
          reasonGiven: r.changeReasonCiphertext !== null,
          createdAt: r.createdAt,
        })),
    );
  }

  addRevision(market: MarketContext, revision: NewPolicyRevision): Promise<number> {
    const revisionNo =
      Math.max(
        0,
        ...[...this.state.revisions.values()]
          .filter((r) => r.marketId === market.marketId && r.policyId === revision.policyId)
          .map((r) => r.revisionNo),
      ) + 1;
    this.state.revisions.set(revision.id, {
      marketId: market.marketId,
      id: revision.id,
      policyId: revision.policyId,
      revisionNo,
      rows: canonical(revision.rows),
      authorAccountId: revision.authorAccountId,
      changeReasonCiphertext: revision.changeReasonCiphertext,
      createdAt: revision.createdAt,
    });
    return Promise.resolve(revisionNo);
  }

  publishRevision(
    market: MarketContext,
    policyId: Id<'ClaimBasisPolicy'>,
    revisionId: Id<'ClaimPolicyRevision'>,
    expectedVersion: number,
  ): Promise<void> {
    const row = this.at(market, policyId, expectedVersion);
    row.publishedRevisionId = revisionId;
    row.version += 1;
    return Promise.resolve();
  }
}

/**
 * Catalog's references as a set of active platform categories per Market; `fail` makes the next
 * call reject (catalog unavailable).
 */
export class FakeCatalogReferences implements CatalogReferences {
  readonly categories = new Map<string, Set<string>>();
  fail = false;
  readonly calls: (readonly string[])[] = [];

  add(market: MarketContext, categoryId: Id<'Category'>): void {
    const set = this.categories.get(market.marketId) ?? new Set<string>();
    set.add(categoryId);
    this.categories.set(market.marketId, set);
  }

  platformCategoriesExist(
    market: MarketContext,
    categoryIds: readonly Id<'Category'>[],
  ): Promise<ReadonlySet<Id<'Category'>>> {
    this.calls.push([...categoryIds]);
    if (this.fail) return Promise.reject(new Error('catalog unavailable'));
    const known = this.categories.get(market.marketId) ?? new Set<string>();
    return Promise.resolve(new Set(categoryIds.filter((id) => known.has(id))));
  }

  /** Published products per Market: product id -> current published revision id. */
  readonly published = new Map<string, Map<string, string>>();
  /** Published variants per `${marketId}|${productId}|${revisionId}`. */
  readonly variants = new Map<string, Set<string>>();

  publish(
    market: MarketContext,
    productId: Id<'Product'>,
    revisionId: Id<'ProductRevision'>,
    variantIds: readonly Id<'Variant'>[] = [],
  ): void {
    const map = this.published.get(market.marketId) ?? new Map<string, string>();
    map.set(productId, revisionId);
    this.published.set(market.marketId, map);
    this.variants.set(`${market.marketId}|${productId}|${revisionId}`, new Set(variantIds));
  }

  publishedProductRevisions(
    market: MarketContext,
    productIds: readonly Id<'Product'>[],
  ): Promise<ReadonlyMap<Id<'Product'>, Id<'ProductRevision'>>> {
    this.calls.push([...productIds]);
    if (this.fail) return Promise.reject(new Error('catalog unavailable'));
    const map = this.published.get(market.marketId) ?? new Map<string, string>();
    const out = new Map<Id<'Product'>, Id<'ProductRevision'>>();
    for (const id of productIds) {
      const revision = map.get(id);
      if (revision !== undefined) out.set(id, revision as Id<'ProductRevision'>);
    }
    return Promise.resolve(out);
  }

  variantsOf(
    market: MarketContext,
    revisions: readonly {
      readonly productId: Id<'Product'>;
      readonly productRevisionId: Id<'ProductRevision'>;
    }[],
  ): Promise<ReadonlyMap<Id<'Product'>, ReadonlySet<Id<'Variant'>>>> {
    this.calls.push(revisions.map((r) => r.productId));
    if (this.fail) return Promise.reject(new Error('catalog unavailable'));
    const out = new Map<Id<'Product'>, ReadonlySet<Id<'Variant'>>>();
    for (const r of revisions) {
      const set = this.variants.get(`${market.marketId}|${r.productId}|${r.productRevisionId}`);
      out.set(r.productId, new Set([...(set ?? [])] as Id<'Variant'>[]));
    }
    return Promise.resolve(out);
  }
}
