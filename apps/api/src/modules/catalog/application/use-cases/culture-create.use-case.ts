import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CULTURE_EDIT } from '../../contracts/permissions';
import { CultureCreatedAudit } from '../../domain/audit';
import {
  CULTURES_PER_MARKET_MAX,
  isCultureCode,
  newCulture,
  parseBadgeColour,
  parseCultureContent,
  parseDisplayOrder,
  parseRequiredCertificationType,
} from '../../domain/culture';
import { checkRequiredCertificationType } from '../cultures/culture-references';
import {
  adminAccountOf,
  closedInput,
  invalidFields,
  refuseClaimWords,
  viewOf,
  type CultureClaimWordFailure,
  type CultureView,
  type ValidationFailure,
} from '../cultures/culture-views';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { CultureRepository } from '../ports/culture.repository';

export interface CultureCreateInput {
  readonly code?: unknown;
  readonly names?: unknown;
  readonly displayOrder?: unknown;
  readonly badgeColour?: unknown;
  readonly requiredCertificationType?: unknown;
}

export type CultureCreateFailure =
  | CultureClaimWordFailure
  | { readonly code: 'access.denied' }
  | { readonly code: 'culture.code-taken' }
  | { readonly code: 'culture.name-taken' }
  | { readonly code: 'culture.limit-reached' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export interface CultureCreateDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly cultures: CultureRepository;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly evaluator: ClaimEvaluator;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

const CREATE_KEYS = [
  'code',
  'names',
  'displayOrder',
  'badgeColour',
  'requiredCertificationType',
] as const;

/**
 * `culture.create` (multi-culture package 1; ADR-0047): an admin defines a culture of the Market as a
 * draft. Rule: the key `catalog.culture.edit` (protected) and the admin population. The code is
 * required, lower case words joined by hyphens, and never changes. The default-locale name and
 * description are required; a text that asserts a certification is refused through the claim-term
 * matcher (fail closed). A required certification type must be an active type of the Market, asked of
 * certification through its facade. Audited.
 */
export class CultureCreate extends UseCase<
  CultureCreateInput,
  { readonly culture: CultureView },
  CultureCreateFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.culture-create',
    rule: { kind: 'permissions', allOf: [CATALOG_CULTURE_EDIT.key] },
  };

  readonly #logger = new Logger('CultureCreate');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CultureCreateDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CultureCreateInput,
  ): Promise<Result<{ readonly culture: CultureView }, CultureCreateFailure>> {
    const result = await this.#create(context, input);
    this.#logger.log({
      msg: 'catalog.culture-create',
      code: result.ok ? 'created' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #create(
    context: CallContext,
    input: CultureCreateInput,
  ): Promise<Result<{ readonly culture: CultureView }, CultureCreateFailure>> {
    const accountId = adminAccountOf(context);
    if (accountId === null) return err({ code: 'access.denied' });
    const body = closedInput(input, CREATE_KEYS);
    if (!body.ok) return body;
    const { market } = context;
    const locales = this.deps.policy.locales(market);
    const problems: { path: string; code: string }[] = [];
    const code = body.value['code'];
    if (!isCultureCode(code)) problems.push({ path: 'code', code: 'format' });
    const content = parseCultureContent(body.value, {
      required: locales.default,
      supported: locales.supported,
    });
    if (!content.ok) problems.push(...content.error);
    let displayOrder = 0;
    if (body.value['displayOrder'] !== undefined) {
      const parsed = parseDisplayOrder(body.value['displayOrder']);
      if (parsed.ok) displayOrder = parsed.value;
      else problems.push(parsed.error);
    }
    let badgeColour: string | null = null;
    if (body.value['badgeColour'] !== undefined) {
      const parsed = parseBadgeColour(body.value['badgeColour']);
      if (parsed.ok) badgeColour = parsed.value;
      else problems.push(parsed.error);
    }
    let requiredType: string | null = null;
    if (body.value['requiredCertificationType'] !== undefined) {
      const parsed = parseRequiredCertificationType(body.value['requiredCertificationType']);
      if (parsed.ok) requiredType = parsed.value;
      else problems.push(parsed.error);
    }
    if (problems.length > 0 || !content.ok || !isCultureCode(code)) return invalidFields(problems);

    const claim = await refuseClaimWords(this.deps.matcher, context, content.value.names, [], code);
    if (claim !== null) return err(claim);
    if (requiredType !== null) {
      const known = await checkRequiredCertificationType(
        this.deps.evaluator,
        context,
        requiredType,
      );
      if (!known.ok) return known;
    }

    return this.deps.unitOfWork.run<{ readonly culture: CultureView }, CultureCreateFailure>(
      market,
      async () => {
        const { cultures } = this.deps;
        if ((await cultures.count(market)) >= CULTURES_PER_MARKET_MAX) {
          return err({ code: 'culture.limit-reached' } as const);
        }
        if (await cultures.codeTaken(market, code)) {
          return err({ code: 'culture.code-taken' } as const);
        }
        const state = newCulture({
          id: this.deps.ids.next<'Culture'>(),
          code,
          content: content.value,
          displayOrder,
          requiredCertificationType: requiredType,
          badgeColour,
          createdBy: accountId,
          now: this.deps.clock.now(),
        });
        const added = await cultures.add(market, state);
        if (added !== null) return err({ code: added } as const);
        await this.deps.audit.record(
          context,
          CultureCreatedAudit.entry(state.id, {
            after: { status: state.status, requiresCertification: requiredType !== null },
          }),
        );
        return ok({ culture: viewOf(state) });
      },
    );
  }
}
