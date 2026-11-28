import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { BusinessActivityReader } from '../ports/business-activity.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

/** One activity a seller may choose: the id, the code and the name in each locale. */
export interface OwnBusinessActivityChoice {
  readonly id: string;
  readonly code: string;
  readonly names: Readonly<Record<string, string>>;
}

export interface OwnBusinessActivitiesAnswer {
  readonly items: readonly OwnBusinessActivityChoice[];
  /** The Market's default locale: the name shown when the seller's own language has none. */
  readonly defaultLocale: string;
}

export type OwnBusinessActivitiesFailure =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' };

export interface OwnBusinessActivitiesDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly activityReader: BusinessActivityReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `own-business-activities.list` (BUG-012 step 2; ADR-0040 decision 4): the ACTIVE business
 * activities of the Market that a seller may choose while setting up the account. Seller
 * population only (`catalog.own-product.edit`, allowed while the seller is not approved). Ids, codes
 * and names only: no scope, category or description. One read-only unit; a read that fails is
 * `access.unavailable`, never an empty list read as "no activity exists".
 */
export class OwnBusinessActivities extends UseCase<
  Record<string, never>,
  OwnBusinessActivitiesAnswer,
  OwnBusinessActivitiesFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-business-activities',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'allow',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnBusinessActivitiesDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
  ): Promise<Result<OwnBusinessActivitiesAnswer, OwnBusinessActivitiesFailure>> {
    const { actor, market } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'seller') {
      return err({ code: 'access.denied' });
    }
    const defaultLocale = this.deps.policy.locales(market).default;
    try {
      const read = await this.deps.unitOfWork.run<
        readonly OwnBusinessActivityChoice[],
        OwnBusinessActivitiesFailure
      >(
        market,
        async () =>
          ok(
            (await this.deps.activityReader.listActive(market)).map((state) => ({
              id: state.id,
              code: state.code,
              names: Object.fromEntries(state.names.map((entry) => [entry.locale, entry.name])),
            })),
          ),
        { readOnly: true },
      );
      return read.ok ? ok({ items: read.value, defaultLocale }) : err(read.error);
    } catch {
      return err({ code: 'access.unavailable' });
    }
  }
}
