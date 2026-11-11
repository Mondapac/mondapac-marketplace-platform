import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { publishableRefusal } from '../../domain/attribute-definition';
import { AttributeDefinitionRevisedAudit } from '../../domain/audit';
import {
  attributeIdOf,
  auditShapeOf,
  closedInput,
  CONTENT_KEYS,
  editorAccountOf,
  marketUnitsRefusal,
  parseEditorContent,
  refuseClaimContent,
  versionOf,
  writeViewOf,
  domainFailureOf,
  type DomainFailure,
  type AttributeWriteFailure,
  type AttributeWriteView,
} from '../attributes/attribute-editor';
import { cancelOpenRelaxation } from '../attributes/attribute-relaxation';
import type { AttributeRelaxationStore } from '../ports/attribute-relaxation.store';
import type { AttributeDefinitionWriteDependencies } from './attribute-definition-create.use-case';

export interface AttributeDefinitionEditDependencies extends AttributeDefinitionWriteDependencies {
  readonly relaxations: AttributeRelaxationStore;
}

export interface AttributeDefinitionEditInput {
  readonly [key: string]: unknown;
}

export type AttributeDefinitionEditFailure =
  | AttributeWriteFailure
  | DomainFailure
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' };

const EDIT_KEYS = ['attributeId', 'version', ...CONTENT_KEYS] as const;

/**
 * `attribute-definition.edit` (attributes plan, package A2): an admin saves the whole content of a
 * draft or published attribute as its next revision (insert-only; earlier revisions stay readable).
 * Rule: the key `catalog.attribute.edit` (protected) and the admin population; never in an
 * acting-as session. The request names the version the admin saw: a later one is
 * `attribute.stale` ("This attribute changed since you opened it. Reload."). Values are added,
 * renamed, reordered or deactivated here; a value is never removed, so nothing that uses it
 * breaks. A published attribute keeps its variant flag, keeps what sellers need (default-locale
 * name, an active value with a default-locale label), and clearing `material` is refused here: it
 * needs the two-person request (catalog design 8.2). Turning `material` on applies at once. Every
 * customer-visible text passes the claim-text check, fail closed. One audit row. An open request
 * to clear `material` named the version this edit replaces, so the same unit cancels it (Q-K14).
 */
export class AttributeDefinitionEdit extends UseCase<
  AttributeDefinitionEditInput,
  { readonly attribute: AttributeWriteView },
  AttributeDefinitionEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-definition-edit',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('AttributeDefinitionEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeDefinitionEditDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeDefinitionEditInput,
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeDefinitionEditFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-definition-edit',
      code: result.ok ? 'revised' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: AttributeDefinitionEditInput,
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeDefinitionEditFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, EDIT_KEYS);
    if (!body.ok) return body;
    const id = attributeIdOf(body.value['attributeId']);
    if (id === null) return err({ code: 'attribute.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    let locales: { readonly default: string; readonly supported: readonly string[] };
    try {
      locales = this.deps.policy.locales(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const content = parseEditorContent(body.value, locales);
    if (!content.ok) return content;
    const notOffered = marketUnitsRefusal(content.value.bounds, this.deps.policy.units(market));
    if (notOffered !== null) {
      return err({ code: 'attribute-definition.measure-invalid', fields: [notOffered] });
    }
    // Checked before the unit opens: the certification facade opens its own.
    const claim = await refuseClaimContent(this.deps, context, content.value);
    if (claim !== null) return err(claim);

    try {
      return await this.deps.unitOfWork.run<
        { readonly attribute: AttributeWriteView },
        AttributeDefinitionEditFailure
      >(market, async () => {
        const { attributeStore } = this.deps;
        const found = await attributeStore.findById(market, id);
        if (found === null) return err({ code: 'attribute.not-found' } as const);
        if (found.state.version !== version.value) return err({ code: 'attribute.stale' } as const);
        const next = found.revise({
          revisionId: this.deps.ids.next<'AttributeDefinitionRevision'>(),
          ...content.value,
          now: this.deps.clock.now(),
        });
        if (!next.ok) return err(domainFailureOf(next.error));
        if (next.value.state.status === 'active') {
          const problem = publishableRefusal(next.value.state, locales.default);
          if (problem !== null) return err(domainFailureOf(problem));
        }
        await attributeStore.saveRevision(market, next.value, accountId);
        await this.deps.audit.record(
          context,
          AttributeDefinitionRevisedAudit.entry(id, {
            before: auditShapeOf(found),
            after: {
              ...auditShapeOf(next.value),
              relaxationRequestId: null,
              requestedByAccountId: null,
            },
          }),
        );
        await cancelOpenRelaxation(this.deps, context, market, id);
        return ok({ attribute: writeViewOf(next.value) });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'attribute.stale' });
      throw error;
    }
  }
}
