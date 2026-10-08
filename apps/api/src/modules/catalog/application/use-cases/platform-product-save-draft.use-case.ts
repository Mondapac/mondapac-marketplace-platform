import { err, parseId } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import type {
  SaveDraft,
  SaveDraftFailure,
  SaveDraftOutput,
} from '../working-copy/save-draft.service';

/** The request as the route will pass it: ids as strings, the draft as parsed JSON. */
export interface PlatformProductSaveDraftInput {
  readonly productId: string;
  readonly content: unknown;
  /** The draft's variant list in order: an id the server minted, or null for a new variant. */
  readonly variantIds: readonly (string | null)[];
}

export type PlatformProductSaveDraftFailure =
  | SaveDraftFailure
  | {
      readonly code: 'validation.failed';
      readonly fields: readonly { readonly path: string; readonly code: string }[];
    };

export interface PlatformProductSaveDraftDependencies {
  readonly saveDraft: SaveDraft;
}

/**
 * `platform-product.save-draft` (catalog design 8.2 row `platform-product.*`; CAT-41, AC 3): an
 * admin saves the working copy of a PLATFORM product, autosave included. Rule: the key
 * `catalog.platform-product.edit`; the gate admits an account that holds it. The author kind
 * comes from the actor's population and nothing else; the request names no author, scope, owner,
 * Market or status (closed input: the three fields below). A SELLER product is refused to an admin
 * by the aggregate (`product.seller-only`), and a seller account never holds the platform key.
 * The claim-text control and the per-field refusal are {@link SaveDraft}'s (design 6.1).
 */
export class PlatformProductSaveDraft extends UseCase<
  PlatformProductSaveDraftInput,
  SaveDraftOutput,
  PlatformProductSaveDraftFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.platform-product-save-draft',
    rule: { kind: 'permissions', allOf: [CATALOG_PLATFORM_PRODUCT_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: PlatformProductSaveDraftDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: PlatformProductSaveDraftInput,
  ): Promise<Result<SaveDraftOutput, PlatformProductSaveDraftFailure>> {
    const { actor } = context;
    if (actor.kind !== 'authenticated' || actor.population !== 'admin') {
      return err({ code: 'access.denied' });
    }
    const parsed = parseInput(input);
    if (!parsed.ok) return parsed;
    return this.deps.saveDraft.execute(context, parsed.value);
  }
}

function parseInput(
  input: PlatformProductSaveDraftInput,
): Result<
  { productId: Id<'Product'>; content: unknown; variantIds: (Id<'Variant'> | null)[] },
  PlatformProductSaveDraftFailure
> {
  const fail = (path: string, code: string): Result<never, PlatformProductSaveDraftFailure> =>
    err({ code: 'validation.failed', fields: [{ path, code }] });
  if (typeof input !== 'object' || input === null) return fail('body', 'type');
  const product = typeof input.productId === 'string' ? parseId<'Product'>(input.productId) : null;
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
  return { ok: true, value: { productId: product.value, content: input.content, variantIds } };
}
