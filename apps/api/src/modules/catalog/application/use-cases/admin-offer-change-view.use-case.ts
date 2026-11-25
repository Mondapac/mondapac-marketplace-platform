import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { PermissionProbe } from '../../../../platform/list-query';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_PRODUCT_VIEW } from '../../contracts/permissions';
import {
  adminOfferChangeRows,
  readAdminOfferChangeFacts,
  type AdminOfferChangeRow,
} from '../offer-changes/admin-offer-change-rows';
import type { ChangeValidationFailure } from '../offer-change-view';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { OfferPendingChangeRepository } from '../ports/offer-pending-change.repository';
import type { OfferRepository } from '../ports/offer.repository';
import type { OwnCatalogReader } from '../ports/own-catalog.reader';
import type { SellerNamesReader } from '../ports/seller-names.reader';

export interface AdminOfferChangeViewInput {
  readonly changeId?: unknown;
}

export type AdminOfferChangeViewFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'offer-change.not-found' }
  | ChangeValidationFailure;

export interface AdminOfferChangeViewDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly pendingChanges: OfferPendingChangeRepository;
  readonly offers: OfferRepository;
  readonly ownReader: OwnCatalogReader;
  readonly policy: CatalogMarketPolicy;
  readonly sellerNames: SellerNamesReader;
  readonly productApproveProbe: PermissionProbe;
}

/**
 * `admin-offer-change.view` (risk-based Offer approval slice 5): one held change in any status, as
 * the list row shows it, with the live Offer's description, handling and tag types next to the
 * proposed ones: the deep link and the drawer of the review queue. Rule: `catalog.product.view`
 * and the admin population. Another Market's change is `offer-change.not-found`. One read-only
 * unit (ADR-0025).
 */
export class AdminOfferChangeView extends UseCase<
  AdminOfferChangeViewInput,
  AdminOfferChangeRow,
  AdminOfferChangeViewFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.admin-offer-change-view',
    rule: { kind: 'permissions', allOf: [CATALOG_PRODUCT_VIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AdminOfferChangeViewDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AdminOfferChangeViewInput,
  ): Promise<Result<AdminOfferChangeRow, AdminOfferChangeViewFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed =
      typeof input?.changeId === 'string' ? parseId<'OfferPendingChange'>(input.changeId) : null;
    if (parsed === null || !parsed.ok) {
      return err({ code: 'validation.failed', fields: [{ path: 'changeId', code: 'format' }] });
    }
    let locale: string;
    try {
      locale = this.deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const { deps } = this;
    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const change = await deps.pendingChanges.findById(market, parsed.value);
        if (change === null) return ok(null);
        const facts = await readAdminOfferChangeFacts(deps, market, [change], locale);
        return ok({ change, facts });
      },
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'offer-change.not-found' });
    const [row] = await adminOfferChangeRows(deps, context, [read.value.change], read.value.facts);
    return row === undefined ? err({ code: 'offer-change.not-found' }) : ok(row);
  }
}
