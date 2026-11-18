import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, Id, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import type { SystemActionProposer, SystemRequestRecorder } from '../../../system-requests';
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
  type ParsedFeatureSet,
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
import { NOTHING_BEFORE } from '../catalogue-actions';
import {
  catalogueReview,
  FEATURE_SET_CREATE_SUBJECT_KIND,
  proposeCatalogueAction,
  requestRef,
  type ProposedOr,
} from '../catalogue-review';

export interface FeatureSetCreateInput {
  readonly [key: string]: unknown;
}

export type FeatureSetCreateFailure =
  | AttributeWriteFailure
  | FeatureSetDomainFailure
  | MembershipRefusal
  | { readonly code: 'feature-set.code-taken' }
  | { readonly code: 'system-requests.already-pending'; readonly pendingNumber: number };

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

export interface FeatureSetCreateDependencies extends FeatureSetWriteDependencies {
  /** The review policy of area catalogue (whether the create waits for approval). */
  readonly review: Pick<SystemRequestRecorder, 'areaPolicy'>;
  /** Files the create for a second admin's approval (Admin Inbox › System requests). */
  readonly proposer: SystemActionProposer;
}

type Output = { readonly featureSet: FeatureSetWriteView };

const CREATE_KEYS = ['code', 'note', ...FEATURE_SET_CONTENT_KEYS] as const;
const MAX_CODE_PROBES = 50;

/**
 * `feature-set.create` (attributes plan, package A4): an admin writes a feature set: its name per
 * language, its groups in order (the Core group first) with a name per language, and in each group
 * its attributes in order with a level (required, recommended or optional). Rule: the key
 * `catalog.attribute.edit` (protected) and the admin population; never in an acting-as session.
 * Every attribute must be an active definition; at most `maxVariantAttributes` vary; every name
 * passes the claim-text check in every language, and a language the check cannot read is refused
 * (fail closed). Nothing sells from a feature set until a category names it. One audit row.
 *
 * A feature set has no delete or archive, so a create cannot be undone by a reviewer: where the
 * Market reviews area catalogue it waits for a second admin's approval instead (owner decision of
 * 18 Nov 2026). After the same checks the answer is the proposal (`request`, with a `note`; the
 * content must fit a request: at most 100 attributes, else `too-large-for-review`) and nothing is
 * written. The approval checks the content again and runs {@link createFeatureSetInUnit}
 * (catalogue-appliers.ts).
 */
export class FeatureSetCreate extends UseCase<
  FeatureSetCreateInput,
  ProposedOr<Output>,
  FeatureSetCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.feature-set-create',
    rule: { kind: 'permissions', allOf: [CATALOG_ATTRIBUTE_EDIT.key] },
  };

  readonly #logger = new Logger('FeatureSetCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: FeatureSetCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: FeatureSetCreateInput,
  ): Promise<Result<ProposedOr<Output>, FeatureSetCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.feature-set-create',
      code: result.ok ? ('featureSet' in result.value ? 'created' : 'proposed') : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: FeatureSetCreateInput,
  ): Promise<Result<ProposedOr<Output>, FeatureSetCreateFailure>> {
    const accountId = editorAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, CREATE_KEYS);
    if (!body.ok) return body;
    const prepared = await prepareFeatureSet(this.deps, context, body.value);
    if (!prepared.ok) return prepared;
    const { market } = context;
    // Its own read-only unit, before this one (units do not nest).
    const policy = await catalogueReview(this.deps.review, context);

    try {
      return await this.deps.unitOfWork.run<ProposedOr<Output>, FeatureSetCreateFailure>(
        market,
        async () => {
          if (policy.reviewed) {
            const checked = await buildContent(this.deps, context, prepared.value);
            if (!checked.ok) return err(checked.error);
            const code = await freeCode(this.deps, context, prepared.value);
            if (!code.ok) return err(code.error);
            const proposed = await proposeCatalogueAction(this.deps.proposer, context, policy, {
              subjectKind: FEATURE_SET_CREATE_SUBJECT_KIND,
              subjectRef: prepared.value.base,
              before: NOTHING_BEFORE,
              after: featureSetProposalValues(prepared.value),
              note: body.value['note'],
              tooLargePath: 'groups',
            });
            if (!proposed.ok) return err(proposed.error);
            const request = requestRef(proposed.value);
            if (request !== null) return ok({ request });
          }
          return createFeatureSetInUnit(this.deps, context, accountId, prepared.value, null);
        },
      );
    } catch (error) {
      if (error instanceof FeatureSetCodeTakenError) return err({ code: 'feature-set.code-taken' });
      throw error;
    }
  }
}

/** A feature set's request, read and checked with no unit open (the claim check opens its own). */
export interface PreparedFeatureSet {
  /** The code asked for, or null to make one from the default-locale name. */
  readonly givenCode: string | null;
  /** The code asked for, or the one made from the default-locale name (before any suffix). */
  readonly base: string;
  readonly parsed: ParsedFeatureSet;
  readonly groupCodes: readonly string[];
  readonly defaultLocale: string;
  readonly maxVariants: number;
}

/**
 * Reads and checks the content of a new feature set with no unit open: the code, the content's
 * shape, the group codes and the claim-text check of every name (fail closed). Shared by the route
 * and by the approval of a proposed create (the approval's pre-unit check).
 */
export async function prepareFeatureSet(
  deps: Pick<FeatureSetWriteDependencies, 'policy' | 'matcher' | 'claimLocales'>,
  context: CallContext,
  body: Readonly<Record<string, unknown>>,
): Promise<Result<PreparedFeatureSet, FeatureSetCreateFailure>> {
  const { market } = context;
  let locales: { readonly default: string; readonly supported: readonly string[] };
  let maxVariants: number;
  try {
    locales = deps.policy.locales(market);
    maxVariants = deps.policy.maxVariantAttributes(market);
  } catch {
    return err({ code: 'access.unavailable' });
  }
  const givenCode = body['code'];
  if (
    givenCode !== undefined &&
    givenCode !== null &&
    (typeof givenCode !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(givenCode))
  ) {
    return invalid('code', 'format');
  }
  const parsed = parseFeatureSetContent(body, locales);
  if (!parsed.ok) return parsed;
  const defaultName = parsed.value.names[locales.default];
  if (defaultName === undefined) return invalid(`names.${locales.default}`, 'required');
  const base = typeof givenCode === 'string' ? givenCode : codeFrom(defaultName);
  if (base === null) return invalid('code', 'required');
  const groupCodes = groupCodesOf(parsed.value.groups, locales.default);
  if (!groupCodes.ok) return groupCodes;
  // Checked before the unit opens: the certification facade opens its own.
  const claim = await refuseClaimTexts(
    deps,
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
  return ok({
    givenCode: typeof givenCode === 'string' ? givenCode : null,
    base,
    parsed: parsed.value,
    groupCodes: groupCodes.value,
    defaultLocale: locales.default,
    maxVariants,
  });
}

/** The content checked against the attributes as they are now, inside the open unit. */
async function buildContent(
  deps: Pick<FeatureSetWriteDependencies, 'attributeAdminReader'>,
  context: CallContext,
  prepared: PreparedFeatureSet,
) {
  const definitions = await deps.attributeAdminReader.definitions(
    context.market,
    ATTRIBUTE_LOAD_MAX,
  );
  return buildFeatureSetContent(
    prepared.parsed,
    prepared.groupCodes,
    new Map(definitions.map((definition) => [definition.code, definition])),
    prepared.maxVariants,
  );
}

/** The code the set gets: the one asked for (which must be free) or the first free derived one. */
async function freeCode(
  deps: Pick<FeatureSetWriteDependencies, 'featureSetStore'>,
  context: CallContext,
  prepared: PreparedFeatureSet,
): Promise<Result<string, FeatureSetCreateFailure>> {
  const { market } = context;
  if (prepared.givenCode !== null) {
    return (await deps.featureSetStore.codeTaken(market, prepared.givenCode))
      ? err({ code: 'feature-set.code-taken' })
      : ok(prepared.givenCode);
  }
  for (let n = 1; n <= MAX_CODE_PROBES; n += 1) {
    const candidate = n === 1 ? prepared.base : `${prepared.base.slice(0, 60)}-${n}`;
    if (!(await deps.featureSetStore.codeTaken(market, candidate))) return ok(candidate);
  }
  return err({ code: 'feature-set.code-taken' });
}

/**
 * Writes a prepared feature set inside the open unit: the content against the attributes as they
 * are now, a free code, the set and its audit row, naming the request whose approval created it
 * (null for an admin's own create). A code taken meanwhile throws `FeatureSetCodeTakenError`.
 */
export async function createFeatureSetInUnit(
  deps: FeatureSetWriteDependencies,
  context: CallContext,
  accountId: Id<'Account'>,
  prepared: PreparedFeatureSet,
  requestId: Id<'SystemRequest'> | null,
): Promise<Result<Output, FeatureSetCreateFailure>> {
  const { market } = context;
  const content = await buildContent(deps, context, prepared);
  if (!content.ok) return err(content.error);
  const code = await freeCode(deps, context, prepared);
  if (!code.ok) return code;
  const family = AttributeFamily.createByAdmin({
    id: deps.ids.next<'AttributeFamily'>(),
    revisionId: deps.ids.next<'AttributeFamilyRevision'>(),
    marketId: market.marketId,
    code: code.value,
    content: content.value,
    defaultLocale: prepared.defaultLocale,
    now: deps.clock.now(),
  });
  if (!family.ok) return err(featureSetDomainFailureOf(family.error));
  await deps.featureSetStore.addNew(market, family.value, accountId);
  await deps.audit.record(
    context,
    AttributeFamilyCreatedAudit.entry(family.value.state.id, {
      after: { ...featureSetAuditShape(family.value), requestId },
    }),
  );
  return ok({ featureSet: featureSetWriteViewOf(family.value) });
}

const NAME_FIELD = 'name-';

/**
 * The content of a proposed feature set as the values of a request (three levels at most): the
 * names per locale, each group with its code and its names as `name-<locale>` fields, and every
 * attribute as one entry naming its group's index, its code and its level.
 */
export function featureSetProposalValues(prepared: PreparedFeatureSet) {
  return {
    action: 'create',
    code: prepared.givenCode,
    names: { ...prepared.parsed.names },
    groups: prepared.parsed.groups.map((group) => ({
      groupCode: group.groupCode,
      ...Object.fromEntries(
        Object.entries(group.names).map(([locale, name]) => [`${NAME_FIELD}${locale}`, name]),
      ),
    })),
    entries: prepared.parsed.groups.flatMap((group, index) =>
      group.attributes.map((entry) => ({ group: index, code: entry.code, level: entry.level })),
    ),
  };
}

/**
 * The request body a proposal's values stand for (what {@link prepareFeatureSet} reads); null when
 * they are not a proposed feature set.
 */
export function featureSetBodyOf(values: unknown): Record<string, unknown> | null {
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord(values) || values['action'] !== 'create') return null;
  const { code, names, groups, entries } = values;
  if (code !== null && typeof code !== 'string') return null;
  if (!isRecord(names) || !Array.isArray(groups) || !Array.isArray(entries)) return null;
  const built: { groupCode?: string; names: Record<string, unknown>; attributes: unknown[] }[] = [];
  for (const group of groups) {
    if (!isRecord(group)) return null;
    // Keys come from request input: collected as pairs and built with `Object.fromEntries`, which
    // defines own properties, so a `__proto__` key never reaches the prototype (Hassan, info).
    const groupNames: [string, unknown][] = [];
    let groupCode: string | undefined;
    for (const [field, value] of Object.entries(group)) {
      if (field === 'groupCode') {
        if (value !== null && typeof value !== 'string') return null;
        if (typeof value === 'string') groupCode = value;
      } else if (field.startsWith(NAME_FIELD)) {
        groupNames.push([field.slice(NAME_FIELD.length), value]);
      } else {
        return null;
      }
    }
    built.push({
      ...(groupCode === undefined ? {} : { groupCode }),
      names: Object.fromEntries(groupNames),
      attributes: [],
    });
  }
  for (const entry of entries) {
    if (!isRecord(entry)) return null;
    const index = entry['group'];
    if (typeof index !== 'number' || !Number.isSafeInteger(index)) return null;
    const group = built[index];
    if (group === undefined) return null;
    group.attributes.push({ code: entry['code'], level: entry['level'] });
  }
  return { ...(code === null ? {} : { code }), names, groups: built };
}
