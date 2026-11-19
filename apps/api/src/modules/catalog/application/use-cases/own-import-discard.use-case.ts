import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';

import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_IMPORT_RUN, CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';

import { isActingAsSession } from '../acting-as';

import type { ImportFileStore } from '../ports/import-file-store';

import type { SellerImportRepository } from '../ports/seller-import.repository';
import {
  dropDiscardedSellerJobs,
  sellerImportIdOf,
  type SellerImportCommonFailure,
} from '../seller-import/seller-import-support';

const ACCESS_KEYS = [CATALOG_OWN_IMPORT_RUN.key, CATALOG_OWN_PRODUCT_EDIT.key] as const;

/** The seller and the account of an actor who may use the import; null for any other actor. */
function sellerActor(context: CallContext): {
  readonly sellerId: Id<'Seller'>;
  readonly accountId: Id<'Account'>;
} | null {
  const { actor } = context;
  if (actor.kind !== 'authenticated' || actor.population !== 'seller' || actor.sellerId === null) {
    return null;
  }
  return { sellerId: actor.sellerId, accountId: actor.accountId };
}

export type OwnImportDiscardFailure =
  SellerImportCommonFailure | { readonly code: 'import.not-discardable' };

export interface OwnImportDiscardDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerJobs: SellerImportRepository;
  readonly importFiles: ImportFileStore;
  readonly clock: Clock;
}

/**
 * `own-import.discard` (design 14c): the seller who uploaded a checked file drops it: the job
 * becomes `discarded`, its file is deleted and then the job and its rows. Only a `checked` job; an
 * import that was confirmed keeps running.
 */
export class OwnImportDiscard extends UseCase<
  { readonly importId: unknown },
  { readonly discarded: true },
  OwnImportDiscardFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-discard',
    rule: { kind: 'permissions', allOf: ACCESS_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportDiscardDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly importId: unknown },
  ): Promise<Result<{ readonly discarded: true }, OwnImportDiscardFailure>> {
    const { market } = context;
    const who = sellerActor(context);
    if (who === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const id = sellerImportIdOf(input?.importId);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    const { deps } = this;
    const now = deps.clock.now();
    const done = await deps.unitOfWork.run<{ readonly fileKey: string }, OwnImportDiscardFailure>(
      market,
      async () => {
        const job = await deps.sellerJobs.find(market, who.sellerId, id);
        if (job === null || job.startedByAccountId !== who.accountId) {
          return err({ code: 'import.not-found' } as const);
        }
        const dropped = await deps.sellerJobs.discard(market, id, now);
        if (dropped === null) return err({ code: 'import.not-discardable' } as const);
        return ok(dropped);
      },
    );
    if (!done.ok) return err(done.error);
    await dropDiscardedSellerJobs(deps, market, [{ id, fileKey: done.value.fileKey }], now);
    return ok({ discarded: true });
  }
}
