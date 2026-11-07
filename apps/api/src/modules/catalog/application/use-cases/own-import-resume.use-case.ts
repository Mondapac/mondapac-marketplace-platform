import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';

import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_IMPORT_RUN, CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';

import { isActingAsSession } from '../acting-as';

import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { SellerImportRepository } from '../ports/seller-import.repository';
import {
  EMPTY_SELLER_PARTS,
  sellerImportIdOf,
  sellerViewOf,
  type SellerImportCommonFailure,
  type SellerImportView,
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

export type OwnImportResumeFailure =
  | SellerImportCommonFailure
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'import.not-resumable' }
  | { readonly code: 'import.already-running' };

export interface OwnImportResumeDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerJobs: SellerImportRepository;
  readonly eligibility: SellerEligibilityReader;
  readonly clock: Clock;
}

/**
 * `own-import.resume` (design 14c): the seller who started a stopped import runs the rest of its rows
 * again, while its file is still stored. A seller who can no longer sell is `seller.not-eligible`.
 */
export class OwnImportResume extends UseCase<
  { readonly importId: unknown },
  SellerImportView,
  OwnImportResumeFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-resume',
    rule: { kind: 'permissions', allOf: ACCESS_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportResumeDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: { readonly importId: unknown },
  ): Promise<Result<SellerImportView, OwnImportResumeFailure>> {
    const { market } = context;
    const who = sellerActor(context);
    if (who === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const id = sellerImportIdOf(input?.importId);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    const { deps } = this;
    if (!(await deps.eligibility.isEligible(context, who.sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const now = deps.clock.now();
    const written = await deps.unitOfWork.run<SellerImportView, OwnImportResumeFailure>(
      market,
      async () => {
        const job = await deps.sellerJobs.find(market, who.sellerId, id);
        if (job === null || job.startedByAccountId !== who.accountId) {
          return err({ code: 'import.not-found' } as const);
        }
        if (job.state !== 'stopped' || job.fileDeletedAt !== null) {
          return err({ code: 'import.not-resumable' } as const);
        }
        if (await deps.sellerJobs.hasActive(market, who.sellerId)) {
          return err({ code: 'import.already-running' } as const);
        }
        if (!(await deps.sellerJobs.resume(market, id))) {
          return err({ code: 'import.not-resumable' } as const);
        }
        return ok(
          sellerViewOf(
            {
              ...job,
              state: 'queued',
              stopReason: null,
              finishedAt: null,
              version: job.version + 1,
            },
            EMPTY_SELLER_PARTS,
            now,
          ),
        );
      },
    );
    return written.ok ? written : err(written.error);
  }
}
