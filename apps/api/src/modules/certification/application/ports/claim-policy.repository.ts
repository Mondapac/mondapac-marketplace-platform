import type { Id, MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { PolicyRow } from '../../domain/claim-policy';

// The claim basis policy of certification slice 13 (design 2.1, 3.7; data design 3.14): one
// root per Market and type, insert-only revisions and their rows. Every method runs in the
// caller's open unit; the Market comes from the `MarketContext` only. Nothing is deleted.

/** A policy root (data design 3.14). */
export interface StoredPolicy {
  readonly id: Id<'ClaimBasisPolicy'>;
  readonly typeId: Id<'CertificationType'>;
  /** Null until a first revision is published: every query gets the type's default. */
  readonly publishedRevisionId: Id<'ClaimPolicyRevision'> | null;
  readonly version: number;
}

/** One revision with its rows, in the canonical order of `claim-policy.ts`. */
export interface StoredPolicyRevision {
  readonly id: Id<'ClaimPolicyRevision'>;
  readonly policyId: Id<'ClaimBasisPolicy'>;
  readonly revisionNo: number;
  readonly rows: readonly PolicyRow[];
  readonly authorAccountId: string;
  readonly changeReasonCiphertext: string | null;
  readonly createdAt: Temporal.Instant;
}

/** A revision in the history list: no rows, no reason text. */
export interface PolicyRevisionSummary {
  readonly id: Id<'ClaimPolicyRevision'>;
  readonly revisionNo: number;
  readonly authorAccountId: string;
  readonly reasonGiven: boolean;
  readonly createdAt: Temporal.Instant;
}

export interface NewPolicyRevision {
  readonly id: Id<'ClaimPolicyRevision'>;
  readonly policyId: Id<'ClaimBasisPolicy'>;
  readonly rows: readonly PolicyRow[];
  readonly authorAccountId: Id<'Account'>;
  readonly changeReasonCiphertext: string | null;
  readonly createdAt: Temporal.Instant;
}

export interface ClaimPolicyRepository {
  /** The policy of a type, or null when none was ever saved. */
  policyOfType(
    market: MarketContext,
    typeId: Id<'CertificationType'>,
  ): Promise<StoredPolicy | null>;
  /**
   * Inserts a policy root with no published revision at version 1. A concurrent insert for the
   * same type (the unique `(market_id, type_id)`) throws `StaleAggregateError`.
   */
  addPolicy(
    market: MarketContext,
    policy: {
      readonly id: Id<'ClaimBasisPolicy'>;
      readonly typeId: Id<'CertificationType'>;
      readonly createdAt: Temporal.Instant;
    },
  ): Promise<void>;
  /**
   * Takes the root's row lock under `expectedVersion` without changing it (lock first: every
   * read after it in the unit sees what committed before, and a concurrent decision waits). A
   * moved version throws `StaleAggregateError`.
   */
  lockPolicy(
    market: MarketContext,
    policyId: Id<'ClaimBasisPolicy'>,
    expectedVersion: number,
  ): Promise<void>;
  revision(
    market: MarketContext,
    revisionId: Id<'ClaimPolicyRevision'>,
  ): Promise<StoredPolicyRevision | null>;
  /** The latest revisions of a policy, newest first. */
  revisions(
    market: MarketContext,
    policyId: Id<'ClaimBasisPolicy'>,
    limit: number,
  ): Promise<readonly PolicyRevisionSummary[]>;
  /**
   * Inserts a revision with the next number of its policy and its rows. A concurrent save that
   * took the same number throws `StaleAggregateError`.
   */
  addRevision(market: MarketContext, revision: NewPolicyRevision): Promise<number>;
  /** Points the policy at `revisionId` and moves its version; a moved version throws stale. */
  publishRevision(
    market: MarketContext,
    policyId: Id<'ClaimBasisPolicy'>,
    revisionId: Id<'ClaimPolicyRevision'>,
    expectedVersion: number,
  ): Promise<void>;
}

export const CLAIM_POLICY_REPOSITORY = Symbol('CLAIM_POLICY_REPOSITORY');
