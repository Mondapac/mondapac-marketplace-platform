import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CATALOG_ATTRIBUTE_SUGGESTION_DECIDE } from '../../contracts/permissions';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { parseBulkItems, runBulkDecide } from '../lists/bulk-decide';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { AttributeSuggestionApprove } from './attribute-suggestion-approve.use-case';
import type { AttributeSuggestionReject } from './attribute-suggestion-reject.use-case';
import {
  adminOnly,
  closed,
  refuse,
  type BulkDecideOutput,
  type BulkDecideRefusal,
} from '../lists/bulk-decide-shared';

export interface AttributeSuggestionBulkDecideDependencies {
  readonly attributeApprove: AttributeSuggestionApprove;
  readonly attributeReject: AttributeSuggestionReject;
  readonly suggestions: AttributeValueSuggestionStore;
  readonly policy: CatalogMarketPolicy;
  readonly unitOfWork: UnitOfWork;
}

/**
 * `attribute-suggestion.bulk-decide`: add the value as the seller wrote it (the default-locale
 * label is the seller's text; the claim check of the single approval still runs), or reject with
 * one reason, up to 50 open suggestions.
 */
export class AttributeSuggestionBulkDecide extends UseCase<
  unknown,
  BulkDecideOutput,
  BulkDecideRefusal
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-suggestion-bulk-decide',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_SUGGESTION_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeSuggestionBulkDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<BulkDecideOutput, BulkDecideRefusal>> {
    if (!adminOnly(context)) return err({ code: 'access.denied' });
    const body = closed(input, ['action', 'items', 'reason']);
    if (!body.ok) return body;
    const items = parseBulkItems(body.value['items']);
    if (!items.ok) return items;
    const action = body.value['action'];
    if (action === 'approve') {
      if (body.value['reason'] !== undefined) return refuse('reason', 'unknown');
      let locale: string;
      try {
        locale = this.deps.policy.locales(context.market).default;
      } catch {
        return err({ code: 'access.unavailable' });
      }
      const done = await runBulkDecide(items.value, async (item) => {
        // The label read needs its own read-only unit; the decision below opens its own.
        const read = await this.deps.unitOfWork.run(
          context.market,
          async () => ok(await this.deps.suggestions.findById(context.market, item.id as never)),
          { readOnly: true },
        );
        if (!read.ok) return err({ code: 'access.unavailable' });
        const found = read.value;
        if (found === null) return err({ code: 'suggestion.not-found' });
        return this.deps.attributeApprove.execute(context, {
          suggestionId: item.id,
          version: item.version,
          labels: { [locale]: found.state.label },
        });
      });
      return ok({ action, ...done });
    }
    if (action === 'reject') {
      const reason = body.value['reason'];
      if (typeof reason !== 'string' || reason.trim() === '') return refuse('reason', 'required');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.attributeReject.execute(context, {
          suggestionId: item.id,
          version: item.version,
          reason,
        }),
      );
      return ok({ action, ...done });
    }
    return refuse('action', 'value');
  }
}
