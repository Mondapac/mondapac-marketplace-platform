import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import { CATALOG_ATTRIBUTE_EDIT } from '../../contracts/permissions';
import { AttributeFamilyRevisedAudit } from '../../domain/audit';
import { ATTRIBUTE_LOAD_MAX, featureSetIdOf } from '../attributes/attribute-admin-views';
import {
  closedInput,
  editorAccountOf,
  refuseClaimTexts,
  versionOf,
  type AttributeWriteFailure,
} from '../attributes/attribute-editor';
import { cancelOpenRelaxation } from '../attributes/attribute-relaxation';
import {
  buildFeatureSetContent,
  FEATURE_SET_CONTENT_KEYS,
  featureSetAuditShape,
  featureSetDomainFailureOf,
  featureSetTexts,
  groupCodesOf,
  materialRemoval,
  membershipChanges,
  parseFeatureSetContent,
  requiredRelaxed,
  type FeatureSetDomainFailure,
  type MembershipRefusal,
} from '../attributes/feature-set-editor';
import type { AttributeRelaxationStore } from '../ports/attribute-relaxation.store';
import type { FeatureSetWriteDependencies } from './feature-set-create.use-case';
import {
  featureSetWriteViewOf,
  type FeatureSetWriteView,
} from '../attributes/feature-set-write-view';

export interface FeatureSetEditDependencies extends FeatureSetWriteDependencies {
  readonly relaxations: AttributeRelaxationStore;
}

export interface FeatureSetEditInput {
  readonly [key: string]: unknown;
}

export type FeatureSetEditFailure =
  | AttributeWriteFailure
  | FeatureSetDomainFailure
  | MembershipRefusal
  | { readonly code: 'feature-set.not-found' }
  | { readonly code: 'feature-set.stale' };

const EDIT_KEYS = ['featureSetId', 'version', ...FEATURE_SET_CONTENT_KEYS] as const;

/**
 * `feature-set.edit` (attributes plan, package A4): an admin saves the whole content of a feature
 * set as its next revision (insert-only; earlier revisions stay readable). Rule: the key
 * `catalog.attribute.edit` (protected) and the admin population; never in an acting-as session. The
 * request names the version the admin saw: a later one is `feature-set.stale`. The same content
 * rules as `feature-set.create` apply, and the claim-text check covers every name. Removing a
 * `material` attribute needs the two-person request, so this edit refuses it. A field that was
 * required and no longer is (dropped or lowered) is recorded in the audit row. An attribute the
 * edit adds or drops cancels that attribute's open relaxation request in the same unit (Q-K14).
 * Products already live keep selling (ت۷); the next submit asks for what is now required.
 */
export class FeatureSetEdit extends UseCase<
  FeatureSetEditInput,
  { readonly featureSet: FeatureSetWriteView },
  FeatureSetEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.feature-set-edit',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('FeatureSetEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: FeatureSetEditDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: FeatureSetEditInput,
  ): Promise<Result<{ readonly featureSet: FeatureSetWriteView }, FeatureSetEditFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.feature-set-edit',
      code: result.ok ? 'revised' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: FeatureSetEditInput,
  ): Promise<Result<{ readonly featureSet: FeatureSetWriteView }, FeatureSetEditFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, EDIT_KEYS);
    if (!body.ok) return body;
    const id = featureSetIdOf(body.value['featureSetId']);
    if (id === null) return err({ code: 'feature-set.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    let locales: { readonly default: string; readonly supported: readonly string[] };
    let maxVariants: number;
    try {
      locales = this.deps.policy.locales(market);
      maxVariants = this.deps.policy.maxVariantAttributes(market);
    } catch {
      return err({ code: 'access.unavailable' });
    }
    const parsed = parseFeatureSetContent(body.value, locales);
    if (!parsed.ok) return parsed;
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
        FeatureSetEditFailure
      >(market, async () => {
        const { featureSetStore } = this.deps;
        const found = await featureSetStore.findById(market, id);
        if (found === null) return err({ code: 'feature-set.not-found' } as const);
        if (found.state.version !== version.value) {
          return err({ code: 'feature-set.stale' } as const);
        }
        const definitions = new Map(
          (await this.deps.attributeAdminReader.definitions(market, ATTRIBUTE_LOAD_MAX)).map(
            (definition) => [definition.code, definition] as const,
          ),
        );
        const content = buildFeatureSetContent(
          parsed.value,
          groupCodes.value,
          definitions,
          maxVariants,
        );
        if (!content.ok) return err(content.error);
        const removal = materialRemoval(found, content.value, definitions);
        if (removal !== null) return err(removal);
        const next = found.revise({
          revisionId: this.deps.ids.next<'AttributeFamilyRevision'>(),
          content: content.value,
          defaultLocale: locales.default,
        });
        if (!next.ok) return err(featureSetDomainFailureOf(next.error));
        await featureSetStore.saveRevision(market, next.value, accountId);
        await this.deps.audit.record(
          context,
          AttributeFamilyRevisedAudit.entry(id, {
            before: featureSetAuditShape(found),
            after: {
              ...featureSetAuditShape(next.value),
              requiredRelaxed: requiredRelaxed(found, next.value),
            },
          }),
        );
        for (const code of membershipChanges(found.state.groups, next.value.state.groups)) {
          const definition = definitions.get(code);
          if (definition !== undefined) {
            await cancelOpenRelaxation(this.deps, context, market, definition.id);
          }
        }
        return ok({ featureSet: featureSetWriteViewOf(next.value) });
      });
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'feature-set.stale' });
      throw error;
    }
  }
}
