import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Id, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import {
  CATALOG_PLATFORM_PRODUCT_EDIT,
  CATALOG_VARIANT_REQUEST_REVIEW,
} from '../../contracts/permissions';
import { VariantRequestDecidedAudit } from '../../domain/audit';
import { draftContentOfRevision } from '../../domain/seller-import/merge-import-row';
import { closedInput, type ValidationFailure } from '../attributes/attribute-editor';
import type { ProductRevisionRepository } from '../ports/product-revision.repository';
import type { ProductRepository } from '../ports/product.repository';
import type { WorkingCopyRepository } from '../ports/working-copy.repository';
import type { SaveDraft, SaveDraftFailure } from '../working-copy/save-draft.service';
import {
  decisionViewOf,
  loadProductVariantFacts,
  requestIdOf,
  requestVersionOf,
  type ProductFactsFailure,
  type VariantRequestDecisionView,
} from '../variant-requests/variant-requests';
import {
  deciderOf,
  loadOpenRequest,
  type VariantRequestDecideDependencies,
  type VariantRequestDecisionFailure,
} from '../variant-requests/variant-request-decide';

export interface VariantRequestApproveInput {
  readonly [key: string]: unknown;
}

export type VariantRequestApproveFailure =
  | VariantRequestDecisionFailure
  | ProductFactsFailure
  | SaveDraftFailure
  | { readonly code: 'access.denied' }
  /** The product has the combination already: map the request instead. */
  | { readonly code: 'variant-request.variant-exists' }
  /** The product has no draft that lists all its variants: open the product first. */
  | { readonly code: 'variant-request.draft-unavailable' }
  | ValidationFailure;

export interface VariantRequestApproveDependencies extends VariantRequestDecideDependencies {
  readonly products: ProductRepository;
  readonly workingCopies: WorkingCopyRepository;
  readonly revisions: ProductRevisionRepository;
  /** The admin content use case's save: the same claim, limit and variant rules as the form. */
  readonly saveDraft: SaveDraft;
}

type Draft = Record<string, unknown>;
const isObject = (value: unknown): value is Draft =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * `variant-request.approve` (variants V7): an admin adds the requested variant to the PLATFORM
 * product's draft, through the same draft save the admin product form uses (its saves limit, its
 * variant cap and its rules), as a new `proposed` variant. The draft then goes through the normal
 * submit and review before any seller can sell the variant. Rule: the keys
 * `catalog.variant-request.review` and `catalog.platform-product.edit`, the admin population, no
 * acting-as session; the request names the version the admin saw.
 *
 * Three steps, because the draft save runs its own units: a read-only unit takes the open request
 * and builds the new draft; the draft save mints the variant; a last unit decides the request at
 * the version read and audits it. A combination the product already has as a published variant is
 * refused (`variant-request.variant-exists`: map it); one a draft already holds as a proposed
 * variant, for example after a failed second step, is reused and nothing is saved twice. No
 * request is decided unless its variant exists.
 */
export class VariantRequestApprove extends UseCase<
  VariantRequestApproveInput,
  { readonly request: VariantRequestDecisionView },
  VariantRequestApproveFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.variant-request-approve',
    rule: {
      kind: 'permissions',
      allOf: [CATALOG_VARIANT_REQUEST_REVIEW.key, CATALOG_PLATFORM_PRODUCT_EDIT.key],
    },
  };

  readonly #logger = new Logger('VariantRequestApprove');

  constructor(
    gate: UseCaseGate,
    private readonly deps: VariantRequestApproveDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: VariantRequestApproveInput,
  ): Promise<
    Result<{ readonly request: VariantRequestDecisionView }, VariantRequestApproveFailure>
  > {
    const result = await this.#approve(context, input);
    this.#logger.log({
      msg: 'catalog.variant-request-approve',
      code: result.ok ? 'approved' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #approve(
    context: CallContext,
    input: VariantRequestApproveInput,
  ): Promise<
    Result<{ readonly request: VariantRequestDecisionView }, VariantRequestApproveFailure>
  > {
    const accountId = deciderOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, ['requestId', 'version']);
    if (!body.ok) return body;
    const id = requestIdOf(body.value['requestId']);
    if (id === null) return err({ code: 'variant-request.not-found' });
    const version = requestVersionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;

    // 1. Read: the open request, and the draft with the new variant laid over it.
    const plan = await this.deps.unitOfWork.run<
      | { readonly kind: 'reuse'; readonly variantId: Id<'Variant'> }
      | {
          readonly kind: 'save';
          readonly productId: Id<'Product'>;
          readonly content: Draft;
          readonly variantIds: (Id<'Variant'> | null)[];
          readonly placeholder: string;
        },
      VariantRequestApproveFailure
    >(
      market,
      async () => {
        const loaded = await loadOpenRequest(this.deps, market, id, version.value);
        if (!loaded.ok) return err(loaded.error);
        const { state } = loaded.value;
        const facts = await loadProductVariantFacts(this.deps, market, state.productId);
        if (!facts.ok) return err(facts.error);
        const existing = facts.value.liveKeys.get(state.optionKey);
        if (existing !== undefined) {
          const variant = facts.value.product.liveVariants.find((v) => v.id === existing);
          if (variant?.state === 'proposed')
            return ok({ kind: 'reuse', variantId: existing } as const);
          return err({ code: 'variant-request.variant-exists' } as const);
        }
        const copy = await this.deps.workingCopies.find(market, state.productId);
        const publishedId = facts.value.product.state.publishedRevisionId;
        const published =
          publishedId === null
            ? null
            : await this.deps.revisions.find(market, state.productId, publishedId);
        const base: Draft | null =
          copy !== null
            ? structuredClone(copy.content as Draft)
            : published !== null
              ? draftContentOfRevision(published.content)
              : null;
        if (base === null) return err({ code: 'variant-request.draft-unavailable' } as const);

        const variants: Draft[] = Array.isArray(base['variants'])
          ? (base['variants'] as unknown[]).filter(isObject).map((variant) => ({ ...variant }))
          : [];
        const liveIds = facts.value.product.liveVariants.map((variant) => variant.id);
        // The save retires every variant the list leaves out, so each live one must be in it.
        for (const live of liveIds) {
          if (!variants.some((variant) => variant['variantId'] === live)) {
            variants.push({ variantId: live });
          }
        }
        const placeholder = `variant-request-${state.id}`;
        variants.push({ variantId: placeholder, optionValues: { ...state.optionValues } });
        return ok({
          kind: 'save',
          productId: state.productId,
          content: { ...base, variants },
          variantIds: [...liveIds, null],
          placeholder,
        } as const);
      },
      { readOnly: true },
    );
    if (!plan.ok) return err(plan.error);

    // 2. The draft save mints the variant (or an earlier try already did).
    let variantId: Id<'Variant'>;
    if (plan.value.kind === 'reuse') variantId = plan.value.variantId;
    else {
      const saved = await this.deps.saveDraft.execute(context, {
        productId: plan.value.productId,
        content: plan.value.content,
        variantIds: plan.value.variantIds,
        placeholders: [plan.value.placeholder],
      });
      if (!saved.ok) return err(saved.error);
      const minted = saved.value.variantIds[saved.value.variantIds.length - 1];
      if (minted === undefined) throw new Error('variant-request.approve: the save minted no id');
      variantId = minted;
    }

    // 3. Decide the request at the version read, in one unit with its audit row.
    try {
      return await this.deps.unitOfWork.run<
        { readonly request: VariantRequestDecisionView },
        VariantRequestApproveFailure
      >(market, async () => {
        const loaded = await loadOpenRequest(this.deps, market, id, version.value);
        if (!loaded.ok) return err(loaded.error);
        // A save of another admin (or a second approval) between steps 2 and 3 may have retired
        // the variant just added: the request is then not decided and the admin reloads.
        const product = await this.deps.products.findById(market, loaded.value.state.productId);
        if (!product?.liveVariants.some((variant) => variant.id === variantId)) {
          return err({ code: 'variant-request.stale' } as const);
        }
        const decided = loaded.value.approve({
          accountId,
          variantId,
          now: this.deps.clock.now(),
        });
        if (!decided.ok) return err(decided.error);
        await this.deps.variantRequests.saveDecision(market, decided.value);
        await this.deps.audit.record(
          context,
          VariantRequestDecidedAudit.entry(decided.value.state.id, {
            before: { status: 'open' },
            after: {
              status: 'approved',
              productId: decided.value.state.productId,
              sellerId: decided.value.state.sellerId,
            },
          }),
        );
        return ok({ request: decisionViewOf(decided.value) });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'variant-request.stale' });
      throw error;
    }
  }
}
