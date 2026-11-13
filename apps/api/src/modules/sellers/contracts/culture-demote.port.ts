import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import type { AccessDenied } from '../../../platform/authz';
import type { SellersUnavailable, SellersValidationFailed } from './sellers.facade';

/** What a demotion did: `remaining` is true when the per-call cap left approvals behind. */
export interface CultureDemoteOutcome {
  readonly demoted: number;
  readonly remaining: boolean;
}

/**
 * Sellers' culture demotion port (ADR-0048, security review M1-R1; restricted by N2 in package
 * 3a): takes every approval of a culture back to `requested`. Catalog's last resort when it could
 * not put a culture's required type back after an approval raced with the change. Rule
 * `anonymous`; in process only; it moves rows only toward `requested`.
 *
 * Not on the sellers facade and not exported by the sellers barrels: the dependency-cruiser rule
 * `culture-demote-port-is-for-catalog-adapter` lets only `sellers` and catalog's
 * `infrastructure/sellers-culture-members.ts` import this file, so no other path can mass-demote a
 * culture's sellers.
 */
export interface CultureDemotePort {
  cultureDemoteApprovals(
    context: CallContext,
    cultureId: Id<'Culture'>,
  ): Promise<
    Result<CultureDemoteOutcome, AccessDenied | SellersValidationFailed | SellersUnavailable>
  >;
}

/** Nest token of the {@link CultureDemotePort}, provided and exported by `SellersModule`. */
export const SELLERS_CULTURE_DEMOTE_PORT = Symbol('SELLERS_CULTURE_DEMOTE_PORT');
