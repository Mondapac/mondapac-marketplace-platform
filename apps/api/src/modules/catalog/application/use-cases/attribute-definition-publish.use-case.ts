import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { AttributeDefinitionPublishedAudit } from '../../domain/audit';
import type { AttributeDefinition } from '../../domain/attribute-definition';
import {
  attributeIdOf,
  auditShapeOf,
  editorAccountOf,
  refuseClaimContent,
  type AttributeWriteFailure,
} from '../attributes/attribute-editor';
import {
  changeStatus,
  type AttributeDefinitionStatusDependencies,
  type AttributeDefinitionStatusFailure,
  type AttributeDefinitionStatusInput,
  type AttributeStatusOutput as Output,
} from '../attributes/attribute-status';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';

export interface AttributeDefinitionPublishDependencies extends AttributeDefinitionStatusDependencies {
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
}

export type AttributeDefinitionPublishFailure =
  AttributeDefinitionStatusFailure | AttributeWriteFailure;

/**
 * `attribute-definition.publish` (attributes plan, package A2): a draft becomes active, and so
 * visible to sellers wherever a feature set names it. Rule: the key `catalog.attribute.edit`
 * (protected) and the admin population; never in an acting-as session. The name in the Market's
 * default locale is required; a select type needs an active value labelled in that locale. Other
 * locales may still be missing: buyers see only the languages that are complete. One audit row.
 *
 * The claim check runs again on the content being published (security review of A2): the
 * certification vocabulary may have gained a term since the draft was saved. It runs before the
 * write unit opens, on the version the admin saw; the write is conditional on that version, so the
 * content checked is the content published.
 */
export class AttributeDefinitionPublish extends UseCase<
  AttributeDefinitionStatusInput,
  Output,
  AttributeDefinitionPublishFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-definition-publish',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('AttributeDefinitionPublish');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeDefinitionPublishDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeDefinitionStatusInput,
  ): Promise<Result<Output, AttributeDefinitionPublishFailure>> {
    const claim = await this.#claimRefusal(context, input);
    const result: Result<Output, AttributeDefinitionPublishFailure> =
      claim !== null
        ? err(claim)
        : await changeStatus(
            this.deps,
            context,
            input,
            (definition, defaultLocale) => definition.publish(defaultLocale),
            (before, after) =>
              this.deps.audit.record(
                context,
                AttributeDefinitionPublishedAudit.entry(before.state.id, {
                  before: { status: 'draft' },
                  after: auditShapeOf(after),
                }),
              ),
          );
    this.#logger.log({
      msg: 'catalog.attribute-definition-publish',
      code: result.ok ? 'published' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  /**
   * The claim check of the draft's content, read with no transaction open. Null when the content
   * passes, and when there is nothing to check here: a caller who is not an editor, an id or a
   * version that does not match, or a definition that is not a draft are answered by the status
   * change itself.
   */
  async #claimRefusal(
    context: CallContext,
    input: AttributeDefinitionStatusInput,
  ): Promise<AttributeWriteFailure | null> {
    if (editorAccountOf(context) === null) return null;
    const id = attributeIdOf((input as { attributeId?: unknown } | null)?.attributeId);
    if (id === null) return null;
    const { market } = context;
    let read: Result<AttributeDefinition | null, never>;
    try {
      read = await this.deps.unitOfWork.run<AttributeDefinition | null, never>(
        market,
        async () => ok(await this.deps.attributeStore.findById(market, id)),
        { readOnly: true },
      );
    } catch {
      // Fail-closed: content that cannot be read is never published unchecked.
      return { code: 'claim-text.check-unavailable' };
    }
    const found = read.ok ? read.value : null;
    if (found === null || found.state.status !== 'draft') return null;
    if (found.state.version !== (input as { version?: unknown }).version) return null;
    const { names, material, isVariantOption, bounds, options, display } = found.state;
    return refuseClaimContent(this.deps, context, {
      names,
      material,
      isVariantOption,
      bounds,
      options,
      display,
    });
  }
}
