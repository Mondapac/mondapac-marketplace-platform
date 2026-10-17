import { Logger } from '@nestjs/common';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';
import { CERTIFICATION_ISSUER_EDIT } from '../../contracts/permissions';
import { IssuerDerecognisedAudit } from '../../domain/audit';
import { IssuerDeactivated } from '../../domain/events';
import { derecognise, type IssuerProblem } from '../../domain/issuer';
import {
  adminOf,
  invalid,
  parseRegistryIssuerId,
  registryFailure,
  versionIn,
  type RegistryDependencies,
  type ValidationFailure,
} from '../registry/registry.shared';

export interface IssuerDerecogniseInput {
  readonly issuerId: unknown;
  readonly version: unknown;
  /** The number of approved certificates the form showed, which the admin confirms. */
  readonly affectedCertificates: unknown;
}

export interface IssuerDerecogniseOutput {
  readonly issuerId: string;
  readonly state: 'derecognised';
  readonly version: number;
  readonly affectedCertificates: number;
}

export type IssuerDerecogniseFailure =
  | { readonly code: 'access.denied' }
  | { readonly code: 'access.unavailable' }
  | { readonly code: 'issuer.not-found' }
  | { readonly code: 'conflict.stale' }
  | IssuerProblem
  | ValidationFailure;

const logger = new Logger('CertificationIssuerDerecognise');

/**
 * `issuers.derecognise`, deactivation form 2 (certification design 3.5 row 4; Q6; brief s12; AC 19):
 * `active` or `closed-to-new` → `derecognised`, terminal. Every certificate naming the issuer is
 * invalid from the commit (`validity.ts` rule 1: `evaluateClaims` reads the issuer's state; no job
 * is waited for). The admin confirms the number of approved certificates affected; the unit first
 * moves the issuer's row under its version (taking the row lock an approval share-locks, so every
 * approval in flight has committed or will see the new state), then counts, and refuses a stale
 * count (`issuer.confirmation-count-mismatch`) by rolling back. A pending reactivation becomes
 * `superseded`. One unit: state, `certification.issuer.derecognised` (with the count) and
 * `issuer-deactivated.v1` (`form: derecognised`), which the own mail handler fans out to each
 * affected seller and `catalog` consumes (ADR-0028 d11). Rule: key `certification.issuer.edit`
 * (protected), not acting-as.
 */
export class IssuerDerecognise extends UseCase<
  IssuerDerecogniseInput,
  IssuerDerecogniseOutput,
  IssuerDerecogniseFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'certification.issuer-derecognise',
    rule: { kind: 'permissions', allOf: [CERTIFICATION_ISSUER_EDIT.key] },
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: RegistryDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: IssuerDerecogniseInput,
  ): Promise<Result<IssuerDerecogniseOutput, IssuerDerecogniseFailure>> {
    const admin = adminOf(context, { write: true });
    if (admin === null) return err({ code: 'access.denied' });
    if (typeof input !== 'object' || input === null) return invalid('body', 'type');
    const issuerId = parseRegistryIssuerId(input.issuerId);
    if (issuerId === null) return invalid('issuerId', 'format');
    const version = versionIn(input.version);
    if (!version.ok) return err(version.error);
    const confirmed = input.affectedCertificates;
    if (typeof confirmed !== 'number' || !Number.isSafeInteger(confirmed) || confirmed < 0) {
      return invalid('affectedCertificates', 'format');
    }
    const { deps } = this;
    const { market } = context;
    const now = deps.clock.now();
    const result = await deps.unitOfWork
      .run<IssuerDerecogniseOutput, IssuerDerecogniseFailure>(market, async () => {
        const issuer = await deps.registry.issuer(market, issuerId);
        if (issuer === null) return err({ code: 'issuer.not-found' } as const);
        if (issuer.state !== 'active' && issuer.state !== 'closed-to-new') {
          return err({
            code: 'issuer.transition-forbidden',
            from: issuer.state,
            to: 'derecognised',
          } as const);
        }
        if (issuer.version !== version.value) return err({ code: 'conflict.stale' } as const);
        const record = { state: issuer.state, expertApproval: null, reactivation: null };
        const seen = derecognise(
          record,
          confirmed,
          await deps.registry.approvedCertificateCount(market, issuerId),
        );
        if (!seen.ok) return err(seen.error);
        // Lock (the version guard), then count again: an approval that committed between the two
        // reads makes the confirmation stale, and the unit rolls back. See the header.
        await deps.registry.setIssuerState(market, {
          id: issuerId,
          expectedVersion: version.value,
          state: 'derecognised',
          accountId: admin.accountId,
          changedAt: now,
        });
        const count = await deps.registry.approvedCertificateCount(market, issuerId);
        const next = derecognise(record, confirmed, count);
        if (!next.ok) return err(next.error);
        const pending = await deps.registry.pendingProposal(
          market,
          'issuer-reactivation',
          issuerId,
        );
        if (pending !== null) {
          await deps.registry.closeProposal(market, {
            id: pending.id,
            expectedVersion: pending.version,
            state: 'superseded',
            decidedByAccountId: null,
            decidedAt: now,
          });
        }
        await deps.audit.record(
          context,
          IssuerDerecognisedAudit.entry(issuerId, {
            after: {
              typeId: issuer.typeId,
              affectedCertificates: count,
              supersededProposalId: pending?.id ?? null,
            },
          }),
        );
        await deps.outbox.append(context, [
          IssuerDeactivated.record({
            aggregateId: issuerId,
            aggregateVersion: version.value + 1,
            occurredAt: now,
            payload: { issuerId, form: 'derecognised' },
          }),
        ]);
        return ok({
          issuerId,
          state: 'derecognised' as const,
          version: version.value + 1,
          affectedCertificates: count,
        });
      })
      .catch((error: unknown) =>
        registryFailure(context, 'certification.issuer-derecognise', error),
      );
    if (result.ok) {
      logger.log({
        msg: 'certification.issuer.derecognised',
        issuerId,
        affectedCertificates: result.value.affectedCertificates,
        marketId: market.marketId,
        correlationId: context.correlationId,
      });
    }
    return result;
  }
}
