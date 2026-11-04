import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type {
  AttributeDefinition,
  AttributeDefinitionRefusal,
} from '../../domain/attribute-definition';
import {
  attributeIdOf,
  closedInput,
  editorAccountOf,
  versionOf,
  writeViewOf,
  domainFailureOf,
  type DomainFailure,
  type AttributeWriteView,
  type ValidationFailure,
} from './attribute-editor';
import type { AttributeDefinitionStore } from '../ports/attribute-definition.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';

export interface AttributeDefinitionStatusInput {
  readonly attributeId?: unknown;
  /** The version the admin saw. */
  readonly version?: unknown;
}

export type AttributeDefinitionStatusFailure =
  | DomainFailure
  | ValidationFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'attribute.not-found' }
  | { readonly code: 'attribute.stale' };

export interface AttributeDefinitionStatusDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeStore: AttributeDefinitionStore;
  readonly policy: CatalogMarketPolicy;
  readonly audit: AuditWriter;
}

export type AttributeStatusOutput = { readonly attribute: AttributeWriteView };

/**
 * The shared body of publish and discard: the admin (never acting-as), the closed input, the
 * version the admin saw, one unit, the domain step, the conditional status write and the audit row.
 */
export async function changeStatus(
  deps: AttributeDefinitionStatusDependencies,
  context: CallContext,
  input: AttributeDefinitionStatusInput,
  step: (
    definition: AttributeDefinition,
    defaultLocale: string,
  ) => Result<AttributeDefinition, AttributeDefinitionRefusal>,
  audit: (before: AttributeDefinition, after: AttributeDefinition) => Promise<void>,
): Promise<Result<AttributeStatusOutput, AttributeDefinitionStatusFailure>> {
  if (editorAccountOf(context) === null) return err({ code: 'access.denied' });
  const body = closedInput(input, ['attributeId', 'version']);
  if (!body.ok) return body;
  const id = attributeIdOf(body.value['attributeId']);
  if (id === null) return err({ code: 'attribute.not-found' });
  const version = versionOf(body.value['version']);
  if (!version.ok) return version;
  const { market } = context;
  let defaultLocale: string;
  try {
    defaultLocale = deps.policy.locales(market).default;
  } catch {
    return err({ code: 'access.unavailable' });
  }
  try {
    return await deps.unitOfWork.run<AttributeStatusOutput, AttributeDefinitionStatusFailure>(
      market,
      async () => {
        const found = await deps.attributeStore.findById(market, id);
        if (found === null) return err({ code: 'attribute.not-found' } as const);
        if (found.state.version !== version.value) return err({ code: 'attribute.stale' } as const);
        const next = step(found, defaultLocale);
        if (!next.ok) return err(domainFailureOf(next.error));
        await deps.attributeStore.saveStatus(market, next.value);
        await audit(found, next.value);
        return ok({ attribute: writeViewOf(next.value) });
      },
    );
  } catch (error) {
    if (error instanceof StaleAggregateError) return err({ code: 'attribute.stale' });
    throw error;
  }
}
