import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { logDraftOutcome, sellerActorOf } from '../draft/draft-support';
import { storeSettingsLogger } from '../store-settings/store-settings';
import type { BusinessFileRevisionRepository } from '../ports/business-file-revision.repository';

export interface OwnZoneView {
  /** The IANA zone the seller chose, from the approved revision. */
  readonly zone: string;
}

export type OwnZoneFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'file.not-found' }
  | { readonly code: 'sellers.unavailable' };

export interface OwnZoneReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly revisions: BusinessFileRevisionRepository;
}

/**
 * `sellers.own-zone-read`: the operating time zone of the acting seller's approved revision, for
 * the seller panel to read and write times in the seller's own zone (special-price windows). Rule
 * `own-resources`, approved sellers only; the seller is the actor's, no route takes a seller id.
 * Only the zone is answered, never a draft value or any personal data. One read-only unit.
 */
export class OwnZoneRead extends UseCase<Record<string, never>, OwnZoneView, OwnZoneFailure> {
  static override readonly access: AccessDeclaration = {
    name: 'sellers.own-zone-read',
    rule: { kind: 'own-resources' },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnZoneReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(context: CallContext): Promise<Result<OwnZoneView, OwnZoneFailure>> {
    const owner = sellerActorOf(context);
    if (owner === null) return err({ code: 'access.denied' });
    try {
      const read = await this.deps.unitOfWork.run<OwnZoneView, OwnZoneFailure>(
        context.market,
        async () => {
          const zones = await this.deps.revisions.approvedZones(context.market, [owner.sellerId]);
          const found = zones.get(owner.sellerId);
          if (found === undefined) return err({ code: 'file.not-found' });
          return ok({ zone: found.operatingTimezone });
        },
        { readOnly: true },
      );
      logDraftOutcome('own-zone-read', context, owner.sellerId, read.ok ? 'read' : read.error.code);
      return read;
    } catch (error) {
      storeSettingsLogger.error({
        msg: 'sellers.own-zone-read.failed',
        error: error instanceof Error ? error.name : 'unknown',
        marketId: context.market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'sellers.unavailable' });
    }
  }
}
