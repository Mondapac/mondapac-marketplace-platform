import type { MarketContext } from '@mondapac/shared-kernel';
import type { CertificationTypeCode } from '../../domain/claim-types';
import type { TypeRevisionContent } from '../../domain/type-revision';

/** One type of a checked-in seed: its code, its status and its first revision (design 5.2). */
export interface SeededType {
  readonly code: CertificationTypeCode;
  readonly status: 'active' | 'inactive';
  readonly content: TypeRevisionContent;
}

/**
 * The versioned seed of certification types per Market (design 5.2). A Market with no seed gets
 * an empty list: it then has no type, and `matchClaimTerms` answers `unavailable` (fail closed).
 */
export interface CertificationTypeSeed {
  types(market: MarketContext): readonly SeededType[];
}

export const CERTIFICATION_TYPE_SEED = Symbol('CERTIFICATION_TYPE_SEED');
