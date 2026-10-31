import { err } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_PLATFORM_PRODUCT_EDIT } from '../../contracts/permissions';
import { parseSaveDraftInput } from '../working-copy/parse-save-draft-input';
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
    const parsed = parseSaveDraftInput(input);
    if (!parsed.ok) return parsed;
    return this.deps.saveDraft.execute(context, parsed.value);
  }
}
