import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Clock, IdGenerator, Result } from '@mondapac/shared-kernel';
import type { AuditWriter } from '../../../../platform/audit/audit-writer';
import type { OutboxWriter } from '../../../../platform/events/outbox-writer';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { StaleAggregateError } from '../../../../platform/unit-of-work/errors';
import type { UnitOfWork } from '../../../../platform/unit-of-work/unit-of-work';
import { CATALOG_CULTURE_EDIT } from '../../contracts/permissions';
import { CultureEditedAudit } from '../../domain/audit';
import {
  editCulture,
  parseBadgeColour,
  parseCultureContent,
  parseDisplayOrder,
  parseRequiredCertificationType,
  type CultureChange,
  type CultureRefusal,
  type CultureState,
} from '../../domain/culture';
import { announceApprovalsInvalidated, announceCultureStatus } from '../cultures/culture-events';
import { checkRequiredCertificationType } from '../cultures/culture-references';
import {
  adminAccountOf,
  closedInput,
  cultureIdOf,
  invalidFields,
  refuseClaimWords,
  statusOf,
  versionOf,
  viewOf,
  type CultureClaimWordFailure,
  type CultureView,
  type ValidationFailure,
} from '../cultures/culture-views';
import type { CatalogMarketPolicy } from '../ports/catalog-market-policy';
import type { ClaimEvaluator } from '../ports/claim-evaluator';
import type { ClaimTermLocales } from '../ports/claim-term-locales';
import type { ClaimTextMatcher } from '../ports/claim-text-matcher';
import type { CultureMembers } from '../ports/culture-members';
import type { CultureRepository } from '../ports/culture.repository';

export interface CultureEditInput {
  readonly cultureId?: unknown;
  /** The version the admin saw. */
  readonly version?: unknown;
  readonly names?: unknown;
  readonly displayOrder?: unknown;
  readonly status?: unknown;
  readonly badgeColour?: unknown;
  readonly requiredCertificationType?: unknown;
  /** `true` makes this culture the Market's default. */
  readonly isDefault?: unknown;
}

export type CultureEditFailure =
  | CultureClaimWordFailure
  | { readonly code: CultureRefusal }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'access.denied' }
  | { readonly code: 'culture.not-found' }
  | { readonly code: 'culture.name-taken' }
  /** A seller is approved in the culture: its required certification type cannot be set or changed. */
  | { readonly code: 'culture.required-type-locked' }
  | { readonly code: 'conflict.stale' }
  | ValidationFailure;

export interface CultureEditDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly cultures: CultureRepository;
  readonly policy: CatalogMarketPolicy;
  readonly matcher: ClaimTextMatcher;
  readonly claimLocales: ClaimTermLocales;
  readonly cultureMembers: CultureMembers;
  readonly evaluator: ClaimEvaluator;
  readonly audit: AuditWriter;
  readonly clock: Clock;
  /** The status event (package 3a) and the N1 reconciliation event. */
  readonly outbox: OutboxWriter;
  readonly ids: IdGenerator;
}

const EDIT_KEYS = [
  'cultureId',
  'version',
  'names',
  'displayOrder',
  'status',
  'badgeColour',
  'requiredCertificationType',
  'isDefault',
] as const;

/**
 * `culture.edit` (multi-culture package 1; ADR-0047): an admin changes a culture: its names (the
 * whole set when given), order, status, badge colour, required certification type, and makes it the
 * Market's default. Rule: the key `catalog.culture.edit` (protected) and the admin population. A
 * field left out is unchanged; `null` clears the badge colour and the required type. The version the
 * admin saw must be current (`conflict.stale`). The code never changes. Domain rules (the default
 * stays active, status moves, only an active culture is made default) are in `editCulture`. Making a
 * culture the default clears the mark on the previous one in the same unit. A new or changed text is
 * claim-checked; a new required type must be an active type of the Market. Audited.
 */
export class CultureEdit extends UseCase<
  CultureEditInput,
  { readonly culture: CultureView },
  CultureEditFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.culture-edit',
    rule: { kind: 'permissions', allOf: [CATALOG_CULTURE_EDIT.key] },
  };

  readonly #logger = new Logger('CultureEdit');

  constructor(
    gate: UseCaseGate,
    private readonly deps: CultureEditDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: CultureEditInput,
  ): Promise<Result<{ readonly culture: CultureView }, CultureEditFailure>> {
    const result = await this.#edit(context, input);
    this.#logger.log({
      msg: 'catalog.culture-edit',
      code: result.ok ? 'edited' : result.error.code,
      marketId: context.market.marketId,
      correlationId: context.correlationId,
    });
    return result;
  }

  async #edit(
    context: CallContext,
    input: CultureEditInput,
  ): Promise<Result<{ readonly culture: CultureView }, CultureEditFailure>> {
    if (adminAccountOf(context) === null) return err({ code: 'access.denied' });
    const body = closedInput(input, EDIT_KEYS);
    if (!body.ok) return body;
    const id = cultureIdOf(body.value['cultureId'], 'cultureId');
    if (!id.ok) return err({ code: 'culture.not-found' });
    const version = versionOf(body.value['version']);
    if (!version.ok) return version;
    const { market } = context;
    const locales = this.deps.policy.locales(market);
    const problems: { path: string; code: string }[] = [];
    const change: { -readonly [K in keyof CultureChange]: CultureChange[K] } = {};
    if (body.value['names'] !== undefined) {
      const content = parseCultureContent(body.value, {
        required: locales.default,
        supported: locales.supported,
      });
      if (content.ok) change.names = content.value.names;
      else problems.push(...content.error);
    }
    if (body.value['displayOrder'] !== undefined) {
      const parsed = parseDisplayOrder(body.value['displayOrder']);
      if (parsed.ok) change.displayOrder = parsed.value;
      else problems.push(parsed.error);
    }
    if (body.value['status'] !== undefined) {
      const parsed = statusOf(body.value['status'], 'status');
      if (parsed.ok) change.status = parsed.value;
      else problems.push(...parsed.error.fields);
    }
    if (body.value['badgeColour'] !== undefined) {
      const parsed = parseBadgeColour(body.value['badgeColour']);
      if (parsed.ok) change.badgeColour = parsed.value;
      else problems.push(parsed.error);
    }
    if (body.value['requiredCertificationType'] !== undefined) {
      const parsed = parseRequiredCertificationType(body.value['requiredCertificationType']);
      if (parsed.ok) change.requiredCertificationType = parsed.value;
      else problems.push(parsed.error);
    }
    if (body.value['isDefault'] !== undefined) {
      if (typeof body.value['isDefault'] === 'boolean') change.isDefault = body.value['isDefault'];
      else problems.push({ path: 'isDefault', code: 'type' });
    }
    if (problems.length > 0) return invalidFields(problems);

    // Read the stored culture first (a read-only unit): the claim check and the type check run
    // outside any unit, and they only need to look at what actually changes.
    const { cultures } = this.deps;
    const read = await this.deps.unitOfWork.run(
      market,
      async () => ok(await cultures.findById(market, id.value)),
      { readOnly: true },
    );
    if (!read.ok) return err({ code: 'access.unavailable' });
    if (read.value === null) return err({ code: 'culture.not-found' });
    const stored = read.value;
    if (stored.version !== version.value) return err({ code: 'conflict.stale' });

    const newType = change.requiredCertificationType;
    const typeChanges = newType !== undefined && newType !== stored.requiredCertificationType;
    // An approval was checked against the type the culture had; while anyone is approved the type
    // does not change (security review M1); asked before any other
    // check and before the write unit, so a locked change writes nothing. Fail closed when sellers cannot answer.
    if (typeChanges) {
      const members = await this.deps.cultureMembers.hasApproved(context, id.value);
      if (!members.ok) return err({ code: 'access.unavailable' });
      if (members.value) return err({ code: 'culture.required-type-locked' });
    }

    if (change.names !== undefined) {
      const claim = await refuseClaimWords(this.deps, context, change.names, stored.names);
      if (claim !== null) return err(claim);
    }
    if (typeof newType === 'string' && newType !== stored.requiredCertificationType) {
      const known = await checkRequiredCertificationType(this.deps.evaluator, context, newType);
      if (!known.ok) return known;
    }

    try {
      const saved = await this.deps.unitOfWork.run<
        { readonly culture: CultureView },
        CultureEditFailure
      >(market, async () => {
        const found = await cultures.findById(market, id.value);
        if (found === null) return err({ code: 'culture.not-found' } as const);
        if (found.version !== version.value) return err({ code: 'conflict.stale' } as const);
        const now = this.deps.clock.now();
        const next = editCulture(found, change, now);
        if (!next.ok) return err({ code: next.error } as const);
        // The single-default index needs the old default cleared before the new one is set.
        if (next.value.isDefault && !found.isDefault) {
          await cultures.clearDefaultExcept(market, found.id, now);
        }
        const saved = await cultures.save(market, next.value, found.version);
        if (saved === 'conflict.stale') return err({ code: 'conflict.stale' } as const);
        // The code of an existing culture never changes, so only a name can collide.
        if (saved !== null) return err({ code: 'culture.name-taken' } as const);
        await this.deps.audit.record(
          context,
          CultureEditedAudit.entry(found.id, {
            before: {
              status: found.status,
              isDefault: found.isDefault,
              requiresCertification: found.requiredCertificationType !== null,
            },
            after: {
              status: next.value.status,
              isDefault: next.value.isDefault,
              requiresCertification: next.value.requiredCertificationType !== null,
              namesChanged: namesChanged(found, next.value),
              orderChanged: found.displayOrder !== next.value.displayOrder,
              badgeChanged: found.badgeColour !== next.value.badgeColour,
              requiredCertificationTypeChanged:
                found.requiredCertificationType !== next.value.requiredCertificationType,
            },
          }),
        );
        // Which Offers the culture can show changes with its status: search re-indexes (ADR-0047
        // decision 8). The version is the one the save wrote.
        if (next.value.status !== found.status) {
          await announceCultureStatus(this.deps, context, next.value);
        }
        return ok({ culture: viewOf(next.value) });
      });
      if (!saved.ok || !typeChanges) return saved;
      return await this.#settleTypeChange(context, saved.value.culture, stored);
    } catch (error) {
      if (error instanceof StaleAggregateError) return err({ code: 'conflict.stale' });
      throw error;
    }
  }

  /**
   * The check above ran before the commit, and an approval may have been written in between (a
   * seller approved in a culture that had no required type a moment ago). Ask again now that the new
   * type is committed: if anyone is approved, or sellers cannot answer, put the old type back and
   * refuse. Together with the guard in `sellers` (an approval re-reads the culture after its commit
   * and takes itself back), no approval can end up outside the type it was checked against.
   */
  async #settleTypeChange(
    context: CallContext,
    saved: CultureView,
    before: CultureState,
  ): Promise<Result<{ readonly culture: CultureView }, CultureEditFailure>> {
    const { market } = context;
    const members = await this.deps.cultureMembers.hasApproved(context, before.id);
    if (members.ok && !members.value) return ok({ culture: saved });
    const reverted = await this.#revert(context, before);
    if (!reverted) {
      // The old type could not be put back (the row kept changing). The approvals were checked
      // against that old type, so they are all taken back to requested instead (fail closed).
      // First a durable request (security review N1): `sellers` demotes on its delivery, and the
      // delivery is retried until no approval is left, so a direct call that stops short or fails
      // is finished later. Then the direct call, so the common case is done at once.
      const queued = await this.#queueDemotion(context, before.id);
      const demoted = await this.deps.cultureMembers.demoteAll(context, before.id);
      this.#logger.error({
        msg: 'catalog.culture-edit.required-type-revert-failed',
        cultureId: before.id,
        approvalsDemoted: demoted.ok && demoted.value,
        demotionQueued: queued,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
      return err({ code: 'access.unavailable' });
    }
    this.#logger.warn({
      msg: 'catalog.culture-edit.required-type-reverted',
      marketId: market.marketId,
      correlationId: context.correlationId,
    });
    return err({ code: members.ok ? 'culture.required-type-locked' : 'access.unavailable' });
  }

  /** Writes `catalog.culture-approvals-invalidated.v1` in a unit of its own; false when it failed. */
  async #queueDemotion(context: CallContext, cultureId: CultureState['id']): Promise<boolean> {
    try {
      const done = await this.deps.unitOfWork.run<true, never>(context.market, async () => {
        await announceApprovalsInvalidated(this.deps, context, cultureId);
        return ok(true as const);
      });
      return done.ok;
    } catch {
      return false;
    }
  }

  /** Puts the old required type back: re-reads and re-applies it, up to 3 times on a stale write. Audited. */
  async #revert(context: CallContext, before: CultureState): Promise<boolean> {
    const { market } = context;
    for (let attempt = 1; attempt <= REVERT_ATTEMPTS; attempt += 1) {
      try {
        const done = await this.deps.unitOfWork.run<boolean, never>(market, async () => {
          const found = await this.deps.cultures.findById(market, before.id);
          if (found === null) return ok(true);
          if (found.requiredCertificationType === before.requiredCertificationType) return ok(true);
          const back = editCulture(
            found,
            { requiredCertificationType: before.requiredCertificationType },
            this.deps.clock.now(),
          );
          if (!back.ok) return ok(false);
          if ((await this.deps.cultures.save(market, back.value, found.version)) !== null) {
            return ok(false);
          }
          await this.deps.audit.record(
            context,
            CultureEditedAudit.entry(found.id, {
              before: {
                status: found.status,
                isDefault: found.isDefault,
                requiresCertification: found.requiredCertificationType !== null,
              },
              after: {
                status: back.value.status,
                isDefault: back.value.isDefault,
                requiresCertification: back.value.requiredCertificationType !== null,
                namesChanged: false,
                orderChanged: false,
                badgeChanged: false,
                requiredCertificationTypeChanged: true,
              },
            }),
          );
          return ok(true);
        });
        if (done.ok && done.value) return true;
      } catch {
        // A stale write or a fault: read again and retry.
      }
    }
    return false;
  }
}

const REVERT_ATTEMPTS = 3;

const namesChanged = (before: CultureState, after: CultureState): boolean =>
  JSON.stringify(before.names) !== JSON.stringify(after.names);
