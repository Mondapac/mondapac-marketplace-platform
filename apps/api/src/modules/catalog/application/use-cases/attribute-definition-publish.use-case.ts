import { Logger } from '@nestjs/common';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { AttributeDefinitionPublishedAudit } from '../../domain/audit';
import { auditShapeOf } from '../attributes/attribute-editor';
import {
  changeStatus,
  type AttributeDefinitionStatusDependencies,
  type AttributeDefinitionStatusFailure,
  type AttributeDefinitionStatusInput,
  type AttributeStatusOutput as Output,
} from '../attributes/attribute-status';

/**
 * `attribute-definition.publish` (attributes plan, package A2): a draft becomes active, and so
 * visible to sellers wherever a feature set names it. Rule: the key `catalog.attribute.edit`
 * (protected) and the admin population; never in an acting-as session. The name in the Market's
 * default locale is required; a select type needs an active value labelled in that locale. Other
 * locales may still be missing: buyers see only the languages that are complete. One audit row.
 */
export class AttributeDefinitionPublish extends UseCase<
  AttributeDefinitionStatusInput,
  Output,
  AttributeDefinitionStatusFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-definition-publish',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('AttributeDefinitionPublish');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeDefinitionStatusDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeDefinitionStatusInput,
  ): Promise<Result<Output, AttributeDefinitionStatusFailure>> {
    const result = await changeStatus(
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
}
