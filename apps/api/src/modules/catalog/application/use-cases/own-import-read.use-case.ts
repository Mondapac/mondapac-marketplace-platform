import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';

import { isActingAsSession } from '../acting-as';

import type { SellerImportRepository } from '../ports/seller-import.repository';

import {
  loadSellerView,
  sellerImportIdOf,
  type SellerImportCommonFailure,
  type SellerImportView,
} from '../seller-import/seller-import-support';

// The reads of the seller import (catalog design 14c). They need `catalog.own-product.view`, the
// seller population and a seller who may be signed in; an acting-as session is refused. Every read
// is scoped to the actor's seller: another seller's job answers the byte-identical
// `import.not-found` of an unknown id.

function sellerOf(context: CallContext) {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'seller' ? actor.sellerId : null;
}

const VIEW_KEYS = [CATALOG_OWN_PRODUCT_VIEW.key] as const;

export interface OwnImportReadDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly sellerJobs: SellerImportRepository;
  readonly clock: Clock;
}

export interface OwnImportReadInput {
  /** The import to read, or null for the seller's latest (what the page opens on). */
  readonly importId: unknown;
}

/**
 * `own-import.read` (design 14c): the state of an import for the page, which also answers the
 * progress poll and, with no id, the seller's latest import or `null` (`own-import.current`).
 */
export class OwnImportRead extends UseCase<
  OwnImportReadInput,
  SellerImportView | null,
  SellerImportCommonFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-read',
    rule: { kind: 'permissions', allOf: VIEW_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnImportReadInput,
  ): Promise<Result<SellerImportView | null, SellerImportCommonFailure>> {
    const { market } = context;
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const wanted = input?.importId ?? null;
    const id = wanted === null ? null : sellerImportIdOf(wanted);
    if (wanted !== null && id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    const { sellerJobs, clock } = this.deps;
    const read = await this.deps.unitOfWork.run<SellerImportView | null, SellerImportCommonFailure>(
      market,
      async () => {
        const job =
          id === null
            ? await sellerJobs.latestOf(market, sellerId)
            : await sellerJobs.find(market, sellerId, id);
        if (job === null)
          return id === null ? ok(null) : err({ code: 'import.not-found' } as const);
        return ok(await loadSellerView(sellerJobs, market, job, clock.now()));
      },
      { readOnly: true },
    );
    if (!read.ok) {
      return read.error.code === 'import.not-found' ? read : err({ code: 'access.unavailable' });
    }
    return read;
  }
}
