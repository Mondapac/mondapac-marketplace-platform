import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import {
  CATALOG_ATTRIBUTE_SUGGESTION_DECIDE,
  CATALOG_CATEGORY_PROPOSAL_DECIDE,
  CATALOG_TOPIC_SUGGESTION_REVIEW,
  CATALOG_VARIANT_REQUEST_REVIEW,
} from '../../contracts/permissions';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { PROPOSAL_REJECT_REASONS } from '../../domain/seller-category';
import { TOPIC_GROUPS } from '../../domain/topic';
import {
  parseBulkItems,
  runBulkDecide,
  type BulkDecideCounts,
  type BulkDecideFailure,
  type BulkDecideResult,
} from '../lists/bulk-decide';
import type { AttributeValueSuggestionStore } from '../ports/attribute-value-suggestion.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { AttributeSuggestionApprove } from './attribute-suggestion-approve.use-case';
import type { AttributeSuggestionReject } from './attribute-suggestion-reject.use-case';
import type { CategoryProposalApprove } from './category-proposal-approve.use-case';
import type { CategoryProposalReject } from './category-proposal-reject.use-case';
import type { TopicSuggestionApprove } from './topic-suggestion-approve.use-case';
import type { TopicSuggestionReject } from './topic-suggestion-reject.use-case';
import type { VariantRequestApprove } from './variant-request-approve.use-case';
import type { VariantRequestDecline } from './variant-request-decline.use-case';

// The bulk accept and reject of the admin queues (super list: bulk actions, at most 50 rows). Each
// row goes through the queue's own single use case, as the caller, in its own unit and with its
// own audit row and key check: a bulk request grants nothing the single decision does not, and a
// row that cannot be decided now (changed, decided, a key missing) is skipped, never forced.

export interface BulkDecideOutput {
  readonly action: string;
  readonly counts: BulkDecideCounts;
  /** Every row, in the order given. */
  readonly results: readonly BulkDecideResult[];
}

export type BulkDecideRefusal =
  { readonly code: 'access.denied' } | { readonly code: 'access.unavailable' } | BulkDecideFailure;

const refuse = (path: string, code: string): { ok: false; error: BulkDecideRefusal } =>
  err({ code: 'validation.failed', fields: [{ path, code }] }) as {
    ok: false;
    error: BulkDecideRefusal;
  };

function closed(
  input: unknown,
  keys: readonly string[],
): Result<Readonly<Record<string, unknown>>, BulkDecideRefusal> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return refuse('body', 'type');
  }
  for (const key of Object.keys(input)) {
    if (!keys.includes(key)) return refuse(key, 'unknown');
  }
  return ok(input as Readonly<Record<string, unknown>>);
}

const adminOnly = (context: CallContext): boolean =>
  context.actor.kind === 'authenticated' && context.actor.population === 'admin';

// --- variant requests (list 4)

export interface VariantRequestBulkDecideDependencies {
  readonly variantApprove: VariantRequestApprove;
  readonly variantDecline: VariantRequestDecline;
}

/** `variant-request.bulk-decide`: approve, or decline with one reason, up to 50 open requests. */
export class VariantRequestBulkDecide extends UseCase<
  unknown,
  BulkDecideOutput,
  BulkDecideRefusal
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.variant-request-bulk-decide',
    rule: { kind: 'permissions', allOf: [CATALOG_VARIANT_REQUEST_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: VariantRequestBulkDecideDependencies,
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
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.variantApprove.execute(context, { requestId: item.id, version: item.version }),
      );
      return ok({ action, ...done });
    }
    if (action === 'decline') {
      const reason = body.value['reason'];
      if (typeof reason !== 'string' || reason.trim() === '') return refuse('reason', 'required');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.variantDecline.execute(context, {
          requestId: item.id,
          version: item.version,
          reason,
        }),
      );
      return ok({ action, ...done });
    }
    return refuse('action', 'value');
  }
}

// --- attribute value suggestions (list 7)

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

// --- tag suggestions (list 11)

export interface TopicSuggestionBulkDecideDependencies {
  readonly topicApprove: TopicSuggestionApprove;
  readonly topicReject: TopicSuggestionReject;
}

/**
 * `topic-suggestion.bulk-decide`: create the tags as the sellers wrote them in one group (name and
 * slug as the single approval derives them), or reject with one reason, up to 50 suggestions.
 */
export class TopicSuggestionBulkDecide extends UseCase<
  unknown,
  BulkDecideOutput,
  BulkDecideRefusal
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.topic-suggestion-bulk-decide',
    rule: { kind: 'permissions', allOf: [CATALOG_TOPIC_SUGGESTION_REVIEW.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: TopicSuggestionBulkDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<BulkDecideOutput, BulkDecideRefusal>> {
    if (!adminOnly(context)) return err({ code: 'access.denied' });
    const body = closed(input, ['action', 'items', 'reason', 'group']);
    if (!body.ok) return body;
    const items = parseBulkItems(body.value['items']);
    if (!items.ok) return items;
    const action = body.value['action'];
    if (action === 'approve') {
      if (body.value['reason'] !== undefined) return refuse('reason', 'unknown');
      const group = body.value['group'];
      if (typeof group !== 'string') return refuse('group', 'required');
      if (!(TOPIC_GROUPS as readonly string[]).includes(group)) return refuse('group', 'value');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.topicApprove.execute(context, {
          suggestionId: item.id,
          version: item.version,
          group,
        }),
      );
      return ok({ action, ...done });
    }
    if (action === 'reject') {
      if (body.value['group'] !== undefined) return refuse('group', 'unknown');
      const reason = body.value['reason'];
      if (typeof reason !== 'string' || reason.trim() === '') return refuse('reason', 'required');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.topicReject.execute(context, {
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

// --- category proposals (list 12)

export interface CategoryProposalBulkDecideDependencies {
  readonly proposalApprove: CategoryProposalApprove;
  readonly proposalReject: CategoryProposalReject;
}

/** `category-proposal.bulk-decide`: approve, or reject with one reason code, up to 50 proposals. */
export class CategoryProposalBulkDecide extends UseCase<
  unknown,
  BulkDecideOutput,
  BulkDecideRefusal
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.category-proposal-bulk-decide',
    rule: { kind: 'permissions', allOf: [CATALOG_CATEGORY_PROPOSAL_DECIDE.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: CategoryProposalBulkDecideDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: unknown,
  ): Promise<Result<BulkDecideOutput, BulkDecideRefusal>> {
    if (!adminOnly(context)) return err({ code: 'access.denied' });
    const body = closed(input, ['action', 'items', 'reasonCode']);
    if (!body.ok) return body;
    const items = parseBulkItems(body.value['items']);
    if (!items.ok) return items;
    const action = body.value['action'];
    if (action === 'approve') {
      if (body.value['reasonCode'] !== undefined) return refuse('reasonCode', 'unknown');
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.proposalApprove.execute(context, {
          proposalId: item.id,
          body: { version: item.version },
        }),
      );
      return ok({ action, ...done });
    }
    if (action === 'reject') {
      const reasonCode = body.value['reasonCode'];
      if (
        typeof reasonCode !== 'string' ||
        !(PROPOSAL_REJECT_REASONS as readonly string[]).includes(reasonCode)
      ) {
        return refuse('reasonCode', 'unknown');
      }
      const done = await runBulkDecide(items.value, (item) =>
        this.deps.proposalReject.execute(context, {
          proposalId: item.id,
          body: { version: item.version, reasonCode },
        }),
      );
      return ok({ action, ...done });
    }
    return refuse('action', 'value');
  }
}
