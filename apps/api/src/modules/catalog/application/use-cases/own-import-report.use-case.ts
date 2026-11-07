import type { OwnImportReadDependencies } from './own-import-read.use-case';
import { err, ok } from '@mondapac/shared-kernel';
import type { CallContext, Result } from '@mondapac/shared-kernel';
import { UseCase, type AccessDeclaration, type UseCaseGate } from '../../../../platform/authz';

import { CATALOG_OWN_PRODUCT_VIEW } from '../../contracts/permissions';
import { IMPORT_LIMITS } from '../../domain/platform-import/limits';

import type {
  SellerImportJob,
  SellerRowRecord,
} from '../../domain/seller-import/seller-import-job';
import { isActingAsSession } from '../acting-as';

import { sellerErrorReportCsv, sellerFullReportCsv } from '../seller-import/seller-import-report';
import {
  sellerImportIdOf,
  type SellerImportCommonFailure,
} from '../seller-import/seller-import-support';

// The reads of the seller import (catalog design 14c). They need `catalog.own-product.view`, the
// seller population and a seller who may be signed in; an acting-as session is refused. Every read
// is scoped to the actor's seller: another seller's job answers the byte-identical
// `import.not-found` of an unknown id.

function sellerOf(context: CallContext) {
  const { actor } = context;
  return actor.kind === 'authenticated' && actor.population === 'seller' ? actor.sellerId : null;
}

const VIEW_KEYS = [CATALOG_OWN_PRODUCT_VIEW.key] as const;

export interface OwnImportReportInput {
  readonly importId: unknown;
  readonly kind: unknown;
}

export interface OwnImportReportOutput {
  readonly filename: string;
  readonly contentType: 'text/csv; charset=utf-8';
  readonly body: string;
}

export type OwnImportReportFailure =
  SellerImportCommonFailure | { readonly code: 'import.report-unavailable' };

const REPORT_PAGE = 500;

/**
 * `own-import.report` (design 14c): the two CSV reports of a job. `errors` is the check's error
 * report, from the check on; `full` is the run's report, once the run finished or stopped. Each
 * cell a spreadsheet would run as a formula is written with a leading quote; the download name is
 * built from the date, never from the upload's name.
 */
export class OwnImportReport extends UseCase<
  OwnImportReportInput,
  OwnImportReportOutput,
  OwnImportReportFailure
> {
  static override readonly access: AccessDeclaration = {
    name: 'catalog.own-import-report',
    rule: { kind: 'permissions', allOf: VIEW_KEYS },
    whenSellerNotApproved: 'deny',
  };

  constructor(
    gate: UseCaseGate,
    private readonly deps: OwnImportReadDependencies,
  ) {
    super(gate);
  }

  protected async handle(
    context: CallContext,
    input: OwnImportReportInput,
  ): Promise<Result<OwnImportReportOutput, OwnImportReportFailure>> {
    const { market } = context;
    const sellerId = sellerOf(context);
    if (sellerId === null) return err({ code: 'access.denied' });
    if (isActingAsSession(context.actor)) return err({ code: 'access.acting-as-refused' });
    const id = sellerImportIdOf(input?.importId);
    if (id === null) {
      return err({ code: 'validation.failed', fields: [{ path: 'importId', code: 'format' }] });
    }
    if (input.kind !== 'errors' && input.kind !== 'full') {
      return err({ code: 'validation.failed', fields: [{ path: 'kind', code: 'enum' }] });
    }
    const kind = input.kind;
    const { sellerJobs } = this.deps;
    const read = await this.deps.unitOfWork.run<
      { job: SellerImportJob; rows: SellerRowRecord[] },
      OwnImportReportFailure
    >(
      market,
      async () => {
        const job = await sellerJobs.find(market, sellerId, id);
        if (job === null) return err({ code: 'import.not-found' } as const);
        if (kind === 'full' && job.state !== 'finished' && job.state !== 'stopped') {
          return err({ code: 'import.report-unavailable' } as const);
        }
        if (kind === 'errors' && job.state === 'discarded') {
          return err({ code: 'import.report-unavailable' } as const);
        }
        const rows: SellerRowRecord[] = [];
        for (let offset = 0; ; offset += REPORT_PAGE) {
          const page = await sellerJobs.rows(
            market,
            id,
            kind === 'errors' ? { checkState: 'error' } : {},
            { offset, limit: REPORT_PAGE },
          );
          rows.push(...page);
          if (page.length < REPORT_PAGE || rows.length >= IMPORT_LIMITS.rows) break;
        }
        return ok({ job, rows });
      },
      { readOnly: true },
    );
    if (!read.ok) {
      return read.error.code === 'import.not-found' ||
        read.error.code === 'import.report-unavailable'
        ? read
        : err({ code: 'access.unavailable' });
    }
    const date = this.deps.clock.now().toString().slice(0, 10);
    return ok({
      filename: kind === 'errors' ? `import-errors-${date}.csv` : `import-report-${date}.csv`,
      contentType: 'text/csv; charset=utf-8',
      body:
        kind === 'errors'
          ? sellerErrorReportCsv(read.value.rows)
          : sellerFullReportCsv(read.value.job, read.value.rows),
    });
  }
}
