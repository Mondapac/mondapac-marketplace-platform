import type { FactoryProvider } from '@nestjs/common';
import type { CallContext, Id } from '@mondapac/shared-kernel';
import {
  AUDIT_TRAIL_READER,
  type AuditTrailReader,
} from '../../../platform/audit/audit-trail-reader';
import {
  CHANGE_TRAIL,
  ChangeTrail,
  type ChangeActorLabel,
  type ChangeActorSource,
} from '../../../platform/audit/change-trail';
import { UNIT_OF_WORK, type UnitOfWork } from '../../../platform/unit-of-work/unit-of-work';
import { IDENTITY_FACADE, type IdentityFacade } from './identity.facade';

/**
 * The {@link ChangeActorSource} of a module's `ChangeTrail`, on identity's facade
 * (`changeActors`): the one adapter every settings page's "last changed by" line and history use,
 * so the privacy rule of who may be named is identity's alone. A refusal of the actor throws, so
 * the caller never shows a guess.
 */
export function changeActorSourceOf(identity: IdentityFacade): ChangeActorSource {
  return {
    async labelsOf(
      context: CallContext,
      accountIds: readonly string[],
    ): Promise<ReadonlyMap<string, ChangeActorLabel>> {
      if (accountIds.length === 0) return new Map();
      const result = await identity.changeActors(context, accountIds as readonly Id<'Account'>[]);
      if (!result.ok) throw new Error(`identity.changeActors refused: ${result.error.code}`);
      return new Map(
        result.value.map((row) => [
          row.accountId,
          { kind: row.kind, displayName: row.displayName },
        ]),
      );
    },
  };
}

/**
 * The module's own {@link ChangeTrail} (`CHANGE_TRAIL`): its audit reader (bound with
 * `PersistenceModule.auditTrailReaderFor('<module>')` in the same module, so it reads only that
 * module's own actions) and identity's names. The module imports `IdentityModule` and never
 * exports the token.
 */
export function changeTrailProvider(): FactoryProvider<ChangeTrail> {
  return {
    provide: CHANGE_TRAIL,
    inject: [UNIT_OF_WORK, AUDIT_TRAIL_READER, IDENTITY_FACADE],
    useFactory: (unitOfWork: UnitOfWork, reader: AuditTrailReader, identity: IdentityFacade) =>
      new ChangeTrail({ unitOfWork, reader, actors: changeActorSourceOf(identity) }),
  };
}
