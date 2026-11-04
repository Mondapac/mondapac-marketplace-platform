import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { AttributeFamily } from '../../domain/attribute-family';
import { AttributeFamilyCreatedAudit } from '../../domain/audit';
import { ATTRIBUTE_LOAD_MAX } from '../attributes/attribute-admin-views';
import {
  closedInput,
  codeFrom,
  editorAccountOf,
  invalid,
  refuseClaimTexts,
  type AttributeWriteFailure,
} from '../attributes/attribute-editor';
import {
  buildFeatureSetContent,
  FEATURE_SET_CONTENT_KEYS,
  featureSetAuditShape,
  featureSetDomainFailureOf,
  featureSetTexts,
  groupCodesOf,
  parseFeatureSetContent,
  type FeatureSetDomainFailure,
  type MembershipRefusal,
} from '../attributes/feature-set-editor';
import type { AttributeAdminReader } from '../ports/attribute-admin.reader';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import { FeatureSetCodeTakenError, type FeatureSetStore } from '../ports/feature-set.store';
import {
  featureSetWriteViewOf,
  type FeatureSetWriteView,
} from '../attributes/feature-set-write-view';

export interface FeatureSetCreateInput {
  readonly [key: string]: unknown;
}

export type FeatureSetCreateFailure =
  | AttributeWriteFailure
  | FeatureSetDomainFailure
  | MembershipRefusal
  | { readonly code: 'feature-set.code-taken' };

export interface FeatureSetWriteDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly featureSetStore: FeatureSetStore;
  readonly attributeAdminReader: AttributeAdminReader;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const CREATE_KEYS = ['code', ...FEATURE_SET_CONTENT_KEYS] as const;
const MAX_CODE_PROBES = 50;

/**
 * `feature-set.create` (attributes plan, package A4): an admin writes a feature set: its name per
 * language, its groups in order (the Core group first) with a name per language, and in each group
 * its attributes in order with a level (required, recommended or optional). Rule: the key
 * `catalog.attribute.edit` (protected) and the admin population; never in an acting-as session.
 * Every attribute must be an active definition; at most `maxVariantAttributes` vary; every name
 * passes the claim-text check in every language, and a language the check cannot read is refused
 * (fail closed). Nothing sells from a feature set until a category names it. One audit row.
 */
export class FeatureSetCreate extends UseCase<
  FeatureSetCreateInput,
  { readonly featureSet: FeatureSetWriteView },
  FeatureSetCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.feature-set-create',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('FeatureSetCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: FeatureSetWriteDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: FeatureSetCreateInput,
  ): Promise<Result<{ readonly featureSet: FeatureSetWriteView }, FeatureSetCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.feature-set-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: FeatureSetCreateInput,
  ): Promise<Result<{ readonly featureSet: FeatureSetWriteView }, FeatureSetCreateFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, CREATE_KEYS);
    if (!body.ok) return body;
    const { market } = context;
    let locales: { readonly default: string; readonly supported: readonly string[] };
    let maxVariants: number;
    try {
      locales = this.deps.policy.locales(market);
      maxVariants = this.deps.policy.maxVariantAttributes(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const givenCode = body.value['code'];
    if (
      givenCode !== undefined &&
      givenCode !== null &&
      (typeof givenCode !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(givenCode))
    ) {
      return invalid('code', 'format');
    }
    const parsed = parseFeatureSetContent(body.value, locales);
    if (!parsed.ok) return parsed;
    const defaultName = parsed.value.names[locales.default];
    if (defaultName === undefined) return invalid(`names.${locales.default}`, 'required');
    const base = typeof givenCode === 'string' ? givenCode : codeFrom(defaultName);
    if (base === null) return invalid('code', 'required');
    const groupCodes = groupCodesOf(parsed.value.groups, locales.default);
    if (!groupCodes.ok) return groupCodes;
    // Checked before the unit opens: the certification facade opens its own.
    const claim = await refuseClaimTexts(
      this.deps,
      context,
      featureSetTexts({
        names: parsed.value.names,
        groups: parsed.value.groups.map((group) => ({
          groupCode: '',
          names: group.names,
          attributes: [],
        })),
      }),
    );
    if (claim !== null) return err(claim);

    try {
      return await this.deps.unitOfWork.run<
        { readonly featureSet: FeatureSetWriteView },
        FeatureSetCreateFailure
      >(market, async () => {
        const { featureSetStore } = this.deps;
        const definitions = await this.deps.attributeAdminReader.definitions(
          market,
          ATTRIBUTE_LOAD_MAX,
        );
        const content = buildFeatureSetContent(
          parsed.value,
          groupCodes.value,
          new Map(definitions.map((definition) => [definition.code, definition])),
          maxVariants,
        );
        if (!content.ok) return err(content.error);
        let code: string | null = null;
        if (typeof givenCode === 'string') {
          if (await featureSetStore.codeTaken(market, givenCode)) {
            return err({ code: 'feature-set.code-taken' } as const);
          }
          code = givenCode;
        } else {
          for (let n = 1; n <= MAX_CODE_PROBES && code === null; n += 1) {
            const candidate = n === 1 ? base : `${base.slice(0, 60)}-${n}`;
            if (!(await featureSetStore.codeTaken(market, candidate))) code = candidate;
          }
          if (code === null) return err({ code: 'feature-set.code-taken' } as const);
        }
        const family = AttributeFamily.createByAdmin({
          id: this.deps.ids.next<'AttributeFamily'>(),
          revisionId: this.deps.ids.next<'AttributeFamilyRevision'>(),
          marketId: market.marketId,
          code,
          content: content.value,
          defaultLocale: locales.default,
          now: this.deps.clock.now(),
        });
        if (!family.ok) return err(featureSetDomainFailureOf(family.error));
        await featureSetStore.addNew(market, family.value, accountId);
        await this.deps.audit.record(
          context,
          AttributeFamilyCreatedAudit.entry(family.value.state.id, {
            after: featureSetAuditShape(family.value),
          }),
        );
        return ok({ featureSet: featureSetWriteViewOf(family.value) });
      });
    } catch (error) {
      if (error instanceof FeatureSetCodeTakenError) return err({ code: 'feature-set.code-taken' });
      throw error;
    }
  }
}
