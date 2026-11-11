import { err } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';

import { CATALOG_OWN_IMPORT_RUN, CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';

import { isActingAsSession } from '../acting-as';

import type {
  OwnProductCreate,
  OwnProductCreateFailure,
  OwnProductCreateInput,
  OwnProductCreateOutput,
} from './own-product-create.use-case';

// The row use cases of the seller import (catalog design 14c, "Limits of a run"). Each is the
// interactive use case of the same action for the job: the same service, so the same guards, the
// claim-text control and the ownership check, but **the interactive save limit is not spent**
// (the import's own limits bound the work). They need both `catalog.own-product.edit` and
// `catalog.own-import.run`, refuse an acting-as session, and no route calls them: only the import run,
// as the seller who started the import. The interactive routes keep their own use cases and limits.
//
// A use case never extends another, so each one holds the interactive use case built with a no-op
// save budget and calls it through its gate: a key taken away stops the row at the inner gate too.

const ACCESS_KEYS = [CATALOG_OWN_PRODUCT_EDIT.key, CATALOG_OWN_IMPORT_RUN.key] as const;

type Refused = AccessDenied | { readonly code: 'access.acting-as-refused' };

function sellerOf(context: CallContext): Id<'Seller'> | null {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'seller' ? actor.sellerId : null;
}

export type OwnImportRowCreateFailure = OwnProductCreateFailure | Refused;

/** `own-import.row-create`: `own-product.create` for a row, with no interactive save spent. */
export class OwnImportRowCreate extends UseCase<
  OwnProductCreateInput,
  OwnProductCreateOutput,
  OwnImportRowCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-row-create',
    rule: { kind: 'permissions', allOf: ACCESS_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: { readonly create: OwnProductCreate },
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductCreateInput,
  ): Promise<Result<OwnProductCreateOutput, OwnImportRowCreateFailure>> {
    if (sellerOf(context) === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    return this.deps.create.execute(context, input);
  }
}
