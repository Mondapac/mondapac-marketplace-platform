import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_OWN_PRODUCT_EDIT } from '../../contracts/permissions';
import type { SellerEligibilityReader } from '../ports/seller-eligibility.reader';
import type {
  SaveDraft,
  SaveDraftFailure,
  SaveDraftOutput,
} from '../working-copy/save-draft.service';

/** The request as the route passes it: ids as strings, the draft as parsed JSON. */
export interface OwnProductSaveDraftInput {
  readonly productId: string;
  readonly content: unknown;
  /** The draft's variant list in order: an id the server minted, or null for a new variant. */
  readonly variantIds: readonly (string | null)[];
}

export type OwnProductSaveDraftFailure =
  | SaveDraftFailure
  | { readonly code: 'seller.not-eligible' }
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface OwnProductSaveDraftDependencies {
  readonly saveDraft: SaveDraft;
  readonly eligibility: SellerEligibilityReader;
}

/**
 * `own-product.save-draft` (catalog design 8.2; OFR-01): a seller saves the working copy of their
 * own SELLER product, autosave included. Rule: the key `catalog.own-product.edit`, the seller
 * population and a seller who may sell. The author kind comes from the actor's population; the
 * request names no author, scope, owner, Market or status. A product of another seller, a
 * PLATFORM product and an unknown id all answer a byte-identical `product.not-found`
 * ({@link SaveDraft} and the save service own the ownership check, the saves limit and the
 * claim-text control).
 */
export class OwnProductSaveDraft extends UseCase<
  OwnProductSaveDraftInput,
  SaveDraftOutput,
  OwnProductSaveDraftFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-product-save-draft',
    rule: { kind: 'permissions', allOf: [CATALOG_OWN_PRODUCT_EDIT.key] },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnProductSaveDraftDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnProductSaveDraftInput,
  ): Promise<Result<SaveDraftOutput, OwnProductSaveDraftFailure>> {
    const { actor } = context;
    if (
      actor.kind !== 'authenticated' ||
      actor.population !== 'seller' ||
      actor.sellerId === null
    ) {
      return err({ code: 'access.denied' });
    }
    if (!(await this.deps.eligibility.isEligible(context, actor.sellerId))) {
      return err({ code: 'seller.not-eligible' });
    }
    const fail = (path: string, code: string): Result<never, OwnProductSaveDraftFailure> =>
      err({ code: 'validation.failed', fields: [{ path, code }] });
    if (typeof input !== 'object' || input === null) return fail('body', 'type');
    const product =
      typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
    if (product === null || !product.ok) return fail('productId', 'format');
    if (!Array.isArray(input.variantIds) || input.variantIds.length > 500) {
      return fail('variantIds', 'type');
    }
    const variantIds: (Id<'Variant'> | null)[] = [];
    for (const [index, value] of (input.variantIds as readonly unknown[]).entries()) {
      if (value === null) {
        variantIds.push(null);
        continue;
      }
      const variant = typeof value === 'string' ? parseId<'Variant'>(value) : null;
      if (variant === null || !variant.ok) return fail(`variantIds[${index}]`, 'format');
      variantIds.push(variant.value);
    }
    return this.deps.saveDraft.execute(context, {
      productId: product.value,
      content: input.content,
      variantIds,
    });
  }
}
