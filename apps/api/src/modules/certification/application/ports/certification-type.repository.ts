import type { MarketContext, Temporal } from '@mondapac/shared-kernel';
import type { SeededType } from './type-seed';

/** What the seed writes for one new type: ids from the injected generator, instants from the Clock. */
export interface NewSeededType {
  readonly typeId: string;
  readonly revisionId: string;
  readonly seeded: SeededType;
  /** Written as the revision's author: the seed has no account (see the use case). */
  readonly authorAccountId: string;
  readonly createdAt: Temporal.Instant;
}

/**
 * Write side of the type registry that the seed needs. Called inside the caller's unit. Nothing
 * here updates or deletes a type or a revision.
 */
export interface CertificationTypeRepository {
  existsByCode(market: MarketContext, code: string): Promise<boolean>;
  /** Inserts the type, its first revision, texts and claim terms, then points at the revision. */
  addSeeded(market: MarketContext, type: NewSeededType): Promise<void>;
}

export const CERTIFICATION_TYPE_REPOSITORY = Symbol('CERTIFICATION_TYPE_REPOSITORY');
