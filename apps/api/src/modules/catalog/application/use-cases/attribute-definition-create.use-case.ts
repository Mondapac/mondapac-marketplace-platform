import { Logger } from '@nestjs/common';
import { ATTRIBUTE_DATA_TYPES, err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { AttributeDefinition } from '../../domain/attribute-definition';
import { AttributeDefinitionCreatedAudit } from '../../domain/audit';
import {
  auditShapeOf,
  closedInput,
  codeFrom,
  CONTENT_KEYS,
  editorAccountOf,
  invalid,
  parseEditorContent,
  refuseClaimContent,
  writeViewOf,
  domainFailureOf,
  type DomainFailure,
  type AttributeWriteFailure,
  type AttributeWriteView,
} from '../attributes/attribute-editor';
import {
  AttributeCodeTakenError,
  type AttributeDefinitionStore,
} from '../ports/attribute-definition.store';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';

export interface AttributeDefinitionCreateInput {
  readonly [key: string]: unknown;
}

export type AttributeDefinitionCreateFailure =
  AttributeWriteFailure | DomainFailure | { readonly code: 'attribute.code-taken' };

export interface AttributeDefinitionWriteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly attributeStore: AttributeDefinitionStore;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const CREATE_KEYS = ['code', 'dataType', 'localizable', ...CONTENT_KEYS] as const;
const MAX_CODE_PROBES = 50;

/**
 * `attribute-definition.create` (attributes plan, package A2): an admin adds an attribute as a
 * draft, which no seller or buyer sees until it is published. Rule: the key
 * `catalog.attribute.edit` (protected) and the admin population; never in an acting-as session.
 * The name in the Market's default locale is required; every name, help text and value label, in
 * every locale, passes the claim-text check, and a locale the check cannot read is refused (fail
 * closed). The code is the one given (which must be free) or derived from the default-locale name;
 * the code, data type and localizable flag never change afterwards. One audit row.
 */
export class AttributeDefinitionCreate extends UseCase<
  AttributeDefinitionCreateInput,
  { readonly attribute: AttributeWriteView },
  AttributeDefinitionCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.attribute-definition-create',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('AttributeDefinitionCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: AttributeDefinitionWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: AttributeDefinitionCreateInput,
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeDefinitionCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.attribute-definition-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: AttributeDefinitionCreateInput,
  ): Promise<Result<{ readonly attribute: AttributeWriteView }, AttributeDefinitionCreateFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, CREATE_KEYS);
    if (!body.ok) return body;
    const { market } = context;
    let locales: { readonly default: string; readonly supported: readonly string[] };
    try {
      locales = this.deps.policy.locales(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const dataType = body.value['dataType'];
    if (
      typeof dataType !== 'string' ||
      !(ATTRIBUTE_DATA_TYPES as readonly string[]).includes(dataType)
    ) {
      return invalid('dataType', 'unknown');
    }
    const localizable = body.value['localizable'] ?? false;
    if (typeof localizable !== 'boolean') return invalid('localizable', 'type');
    const givenCode = body.value['code'];
    if (
      givenCode !== undefined &&
      givenCode !== null &&
      (typeof givenCode !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(givenCode))
    ) {
      return invalid('code', 'format');
    }
    const content = parseEditorContent(body.value, locales);
    if (!content.ok) return content;
    const defaultName = content.value.names[locales.default];
    if (defaultName === undefined) return invalid(`names.${locales.default}`, 'required');
    const base = typeof givenCode === 'string' ? givenCode : codeFrom(defaultName);
    if (base === null) return invalid('code', 'required');

    const now = this.deps.clock.now();
    const draft = AttributeDefinition.createDraft({
      id: this.deps.ids.next<'AttributeDefinition'>(),
      revisionId: this.deps.ids.next<'AttributeDefinitionRevision'>(),
      marketId: market.marketId,
      code: base,
      dataType,
      localizable,
      material: content.value.material,
      isVariantOption: content.value.isVariantOption,
      bounds: content.value.bounds,
      names: content.value.names,
      options: content.value.options,
      display: content.value.display,
      now,
    });
    if (!draft.ok) return err(domainFailureOf(draft.error));
    const claim = await refuseClaimContent(this.deps, context, content.value);
    if (claim !== null) return err(claim);

    try {
      return await this.deps.unitOfWork.run<
        { readonly attribute: AttributeWriteView },
        AttributeDefinitionCreateFailure
      >(market, async () => {
        const { attributeStore } = this.deps;
        let code: string | null = null;
        if (typeof givenCode === 'string') {
          if (await attributeStore.codeTaken(market, givenCode)) {
            return err({ code: 'attribute.code-taken' } as const);
          }
          code = givenCode;
        } else {
          for (let n = 1; n <= MAX_CODE_PROBES && code === null; n += 1) {
            const candidate = n === 1 ? base : `${base.slice(0, 60)}-${n}`;
            if (!(await attributeStore.codeTaken(market, candidate))) code = candidate;
          }
          if (code === null) return err({ code: 'attribute.code-taken' } as const);
        }
        const built =
          code === base
            ? draft
            : AttributeDefinition.createDraft({ ...draft.value.state, code, now });
        if (!built.ok) return err(domainFailureOf(built.error));
        await attributeStore.addDraft(market, built.value, accountId);
        await this.deps.audit.record(
          context,
          AttributeDefinitionCreatedAudit.entry(built.value.state.id, {
            after: auditShapeOf(built.value),
          }),
        );
        return ok({ attribute: writeViewOf(built.value) });
      });
    } catch (error) {
      if (error instanceof AttributeCodeTakenError) return err({ code: 'attribute.code-taken' });
      throw error;
    }
  }
}
