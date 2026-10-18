import type { Id, MarketContext } from '@mondapac/shared-kernel';
import type { ExpertApproval } from '../../domain/issuer';

/** Where an expert approval is kept: on the issuer, or on a pending reactivation proposal. */
export type ExpertReferenceHolder = 'issuer' | 'proposal';

/** A change reason as a read shows it (design 7.6): its text, or erased with its key. */
export type ChangeReasonRead =
  { readonly state: 'given'; readonly text: string } | { readonly state: 'erased' };

/**
 * The encryption of the registry's admin text (data design CE7, CE8, 3.22):
 *
 * - The expert approval reference of an issuer may name a person, so it is sealed under the
 *   Market's platform subject. The subject is created on first use, in a unit of its own, with
 *   its key (never destroyed). Sealing and opening run outside any unit.
 * - The optional change reason gets a subject of its own, the id of the row that holds it (the
 *   type revision or the reactivation proposal), so it can be erased by destroying that key.
 *   `sealChangeReason` creates the key and must run inside the save's open read-write unit.
 *
 * Plaintext never reaches a log, an event, an audit row or an error. A failure that is not the
 * erasure of a reason key throws (PF 4).
 */
export interface RegistryCipher {
  sealExpertApproval(
    market: MarketContext,
    holder: ExpertReferenceHolder,
    approval: ExpertApproval,
  ): Promise<string>;
  openExpertApproval(
    market: MarketContext,
    holder: ExpertReferenceHolder,
    sealed: string,
  ): Promise<ExpertApproval>;
  sealChangeReason(market: MarketContext, holderId: Id, text: string): Promise<string>;
  openChangeReason(market: MarketContext, holderId: Id, sealed: string): Promise<ChangeReasonRead>;
}

export const REGISTRY_CIPHER = Symbol('CERTIFICATION_REGISTRY_CIPHER');
