import { err, ok, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import {
  UseCase,
  type AccessDeclaration,
  type AccessDenied,
  type UseCaseGate,
} from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_OWN_IMPORT_RUN, CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import {
  draftContentOfRevision,
  mergeImportRow,
  withMintedIds,
} from '../../domain/seller-import/merge-import-row';
import type { SellerGroupPlan } from '../../domain/seller-import/row-check';
import { isActingAsSession } from '../acting-as';
import type { AllowedProductTypesReader } from '../ports/allowed-product-types.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ProductRepository } from '../ports/product.repository';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import type { SaveDraft, SaveDraftFailure, RefusedField } from '../working-copy/save-draft.service';
import type {
  OwnProductCreate,
  OwnProductCreateFailure,
  OwnProductCreateInput,
  OwnProductCreateOutput,
} from './own-product-create.use-case';
import type {
  OwnOfferCreateOnPlatformProduct,
  OwnOfferCreateOnPlatformProductFailure,
  OwnOfferCreateOnPlatformProductInput,
  OwnOfferCreateOnPlatformProductOutput,
} from './own-offer-create-on-platform-product.use-case';
import type {
  OwnOfferEdit,
  OwnOfferEditFailure,
  OwnOfferEditInput,
  OwnOfferEditOutput,
} from './own-offer-edit.use-case';

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

export type OwnImportRowOfferCreateFailure = OwnOfferCreateOnPlatformProductFailure | Refused;

/** `own-import.row-offer-create`: an Offer on a catalogue product for a row. */
export class OwnImportRowOfferCreate extends UseCase<
  OwnOfferCreateOnPlatformProductInput,
  OwnOfferCreateOnPlatformProductOutput,
  OwnImportRowOfferCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-row-offer-create',
    rule: { kind: 'permissions', allOf: ACCESS_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: { readonly create: OwnOfferCreateOnPlatformProduct },
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferCreateOnPlatformProductInput,
  ): Promise<Result<OwnOfferCreateOnPlatformProductOutput, OwnImportRowOfferCreateFailure>> {
    if (sellerOf(context) === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    return this.deps.create.execute(context, input);
  }
}

export type OwnImportRowOfferEditFailure = OwnOfferEditFailure | Refused;

/** `own-import.row-offer-edit`: `own-offer.edit` for a row; its tags are asked again as ever. */
export class OwnImportRowOfferEdit extends UseCase<
  OwnOfferEditInput,
  OwnOfferEditOutput,
  OwnImportRowOfferEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-row-offer-edit',
    rule: { kind: 'permissions', allOf: ACCESS_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: { readonly edit: OwnOfferEdit },
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnOfferEditInput,
  ): Promise<Result<OwnOfferEditOutput, OwnImportRowOfferEditFailure>> {
    if (sellerOf(context) === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    return this.deps.edit.execute(context, input);
  }
}

/** The request: the product and the checked plan of its group. */
export interface OwnImportRowSaveInput {
  readonly productId: string;
  readonly plan: SellerGroupPlan;
}

export interface OwnImportRowSaveOutput {
  /** The registry list after the save, new variants included. */
  readonly variantIds: readonly string[];
  /** True when the plan changed nothing and no save was made. */
  readonly unchanged: boolean;
}

export type OwnImportRowSaveFailure =
  | SaveDraftFailure
  | Refused
  | { readonly code: 'seller.not-eligible' }
  | { readonly code: 'type.not-allowed' }
  | { readonly code: 'claim-text.refused'; readonly fields: readonly RefusedField[] }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnImportRowSaveDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
  readonly saveDraft: SaveDraft;
  readonly eligibility: SellerEligibilityReader;
  readonly allowedTypes: AllowedProductTypesReader;
  readonly policy: CatalogMarketPolicy;
}

/**
 * `own-import.row-save`: the draft save of one group of a seller import. It reads the stored draft
 * (else the published revision as a draft), lays the plan over it ({@link mergeImportRow}: an
 * empty cell keeps the stored value) and saves through the draft save, so the attribute schema, the
 * claim-text control and the variant registry are the interactive ones, without the interactive
 * limit. A new variant is saved with a placeholder id and the id the save mints replaces it in a
 * second save. The type of the product is checked against the seller's SEL-12 list again. A text the
 * claim-text control refuses fails the group (`claim-text.refused`); it is not stored.
 */
export class OwnImportRowSave extends UseCase<
  OwnImportRowSaveInput,
  OwnImportRowSaveOutput,
  OwnImportRowSaveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-row-save',
    rule: { kind: 'permissions', allOf: ACCESS_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportRowSaveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnImportRowSaveInput,
  ): Promise<Result<OwnImportRowSaveOutput, OwnImportRowSaveFailure>> {
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const { deps } = this;
    const { market } = context;
    const parsed = typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (parsed === null || !parsed.ok || input.plan.product === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'productId', code: 'format' }] });
    }
    const productId = parsed.value;
    if (!(await deps.eligibility.isEligible(context, sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }

    let defaultLocale: string;
    try {
      defaultLocale = deps.policy.locales(market).default;
    } catch {
      return err({ code: 'access.unavailable' });
    }

    const read = await deps.unitOfWork.run(
      market,
      async () => {
        const product = await deps.products.findById(market, productId);
        if (product === null || product.state.ownerSellerId !== sellerId) {
          return err({ code: 'product.not-found' } as const);
        }
        const stored = await deps.workingCopies.find(market, productId);
        let content: Readonly<Record<string, unknown>> | null = stored?.content ?? null;
        if (content === null && product.state.publishedRevisionId !== null) {
          const revision = await deps.revisions.find(
            market,
            productId,
            product.state.publishedRevisionId,
          );
          if (revision !== null) content = draftContentOfRevision(revision.content);
        }
        return ok({
          typeCode: product.state.typeCode as string,
          content: content ?? {},
          liveVariantIds: product.liveVariants.map((variant) => variant.id as string),
        });
      },
      { readOnly: true },
    );
    if (!read.ok) {
      return err(read.error.code === 'product.not-found' ? read.error : { code: 'access.unavailable' });
    }
    const base = read.value;

    const allowed = await deps.allowedTypes.allowedFor(context, sellerId);
    if (allowed === null) return err({ code: 'access.unavailable' });
    if (allowed !== 'all' && !allowed.has(base.typeCode)) return err({ code: 'type.not-allowed' });

    const merged = mergeImportRow(
      { content: base.content, liveVariantIds: base.liveVariantIds },
      input.plan,
      { defaultLocale },
    );
    if (!merged.changed) return ok({ variantIds: base.liveVariantIds, unchanged: true });

    const variantIds = merged.variantIds.map((id) => {
      if (id === null) return null;
      const variant = parseId<'Variant'>(id);
      return variant.ok ? variant.value : null;
    });
    const first = await deps.saveDraft.execute(
      context,
      { productId, content: merged.content, variantIds },
      { spendSavesLimit: false },
    );
    if (!first.ok) return first;
    if (first.value.refusedFields.length > 0) {
      return err({ code: 'claim-text.refused', fields: first.value.refusedFields });
    }
    let finalIds: readonly string[] = first.value.variantIds;
    if (merged.placeholders.length > 0) {
      const minted = first.value.variantIds.slice(base.liveVariantIds.length);
      const content = withMintedIds(merged.content, merged.placeholders, minted);
      const second = await deps.saveDraft.execute(
        context,
        { productId, content, variantIds: first.value.variantIds },
        { spendSavesLimit: false },
      );
      if (!second.ok) return second;
      if (second.value.refusedFields.length > 0) {
        return err({ code: 'claim-text.refused', fields: second.value.refusedFields });
      }
      finalIds = second.value.variantIds;
    }
    return ok({ variantIds: finalIds, unchanged: false });
  }
}
